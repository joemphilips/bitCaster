"""Linux-only supervisor for the two recovery fixtures' CLI process trees."""
import base64
import ctypes
import json
import os
import selectors
import signal
import sys
import time


def run():
    if sys.platform != 'linux':
        raise RuntimeError('unsupported platform')
    # Adopt the CLI's daemon child if the CLI exits first.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('subreaper unavailable')
    timeout, limit = int(sys.argv[1]) / 1000, int(sys.argv[2])
    if not 0 < timeout <= 300 or not 0 < limit <= 2 * 1024 * 1024:
        raise ValueError('invalid bounds')
    cancelled = False

    def cancel(*_):
        nonlocal cancelled
        cancelled = True

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    ready_r, ready_w = os.pipe()
    go_r, go_w = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            signal.signal(signal.SIGINT, signal.SIG_DFL)
            os.setsid()
            os.close(go_w)
            os.write(ready_w, b'1')
            if os.read(go_r, 1) != b'1':
                os._exit(127)
            for source, target in ((os.open(os.devnull, os.O_RDONLY), 0), (out_w, 1), (err_w, 2)):
                os.dup2(source, target)
            os.closerange(3, 1024)
            os.execv(sys.argv[3], sys.argv[3:])
        except BaseException:
            os._exit(127)
    for fd in (out_w, err_w, ready_w, go_r):
        os.close(fd)
    output = bytearray()
    count = 0
    ready = False
    status = None
    failed = False
    deadline = time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    for fd in (out_r, err_r, ready_r, 0):
        os.set_blocking(fd, False)
        selector.register(fd, selectors.EVENT_READ)
    try:
        while True:
            # WNOWAIT pins the group leader's PID until the final group signal.
            status = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if cancelled or time.monotonic() >= deadline:
                failed = True
                break
            events = selector.select(min(.05, max(0, deadline - time.monotonic())))
            for key, _ in events:
                data = os.read(key.fd, 65536)
                if not data:
                    selector.unregister(key.fd)
                    if key.fd == 0:
                        failed = True  # The owning actor closed its control pipe.
                elif key.fd == ready_r:
                    ready = data == b'1'
                    if ready:
                        os.write(go_w, b'1')
                elif key.fd in (out_r, err_r):
                    count += len(data)
                    if count > limit:
                        failed = True
                    elif key.fd == out_r:
                        output.extend(data)
            if failed or status is not None:
                break
    finally:
        # The leader is still unreaped. Its PID cannot identify another group.
        if ready:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            os.kill(pid, signal.SIGKILL)
        cleanup_deadline = time.monotonic() + 5
        while True:
            try:
                child, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if not child:
                if time.monotonic() >= cleanup_deadline:
                    raise RuntimeError('fixture cleanup deadline')
                # This wait measures process termination, not application readiness.
                time.sleep(.01)
        # Drain final bounded bytes only after every owned descendant has exited.
        for fd in (out_r, err_r):
            while True:
                data = os.read(fd, 65536)
                if not data:
                    break
                count += len(data)
                if count > limit:
                    failed = True
                elif fd == out_r:
                    output.extend(data)
        selector.close()
        for fd in (out_r, err_r, ready_r, go_w):
            os.close(fd)
    if failed or status is None or status.si_code != os.CLD_EXITED or status.si_status != 0:
        raise RuntimeError('fixture command failed')
    print(json.dumps({'stdout': base64.b64encode(output).decode('ascii')}))


try:
    run()
except BaseException:
    # Do not expose command output, arguments, or exception values.
    sys.stderr.write('owned recovery command refused\n')
    sys.exit(1)
