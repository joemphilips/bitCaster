use std::io::{self, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

use bitcaster_oracle_helper::{error_response, execute, MAX_INPUT_BYTES};

fn main() {
    std::panic::set_hook(Box::new(|_| {}));

    if std::env::args_os().len() != 1 {
        let mut output = error_response("invalid-request");
        output.push(b'\n');
        let _ = io::stdout().lock().write_all(&output);
        std::process::exit(1);
    }

    let mut input = Vec::new();
    let read_result = io::stdin()
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut input);

    let (response, success) = if read_result.is_err() || input.len() > MAX_INPUT_BYTES {
        (error_response("invalid-request"), false)
    } else {
        catch_unwind(AssertUnwindSafe(|| execute(&input)))
            .unwrap_or_else(|_| (error_response("internal-failure"), false))
    };

    let mut output = response;
    output.push(b'\n');
    let write_result = io::stdout().lock().write_all(&output);
    if write_result.is_err() || !success {
        std::process::exit(1);
    }
}
