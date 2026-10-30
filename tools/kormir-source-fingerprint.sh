#!/usr/bin/env bash
# Shared source inputs for the browser oracle build and freshness check.

kormir_source_fingerprint() {
    local repository="$1"
    local paths=(Cargo.toml Cargo.lock kormir kormir-wasm dlc dlc-messages)
    local path

    for path in "${paths[@]}"; do
        git -C "$repository" cat-file -e "HEAD:$path" || return 1
    done
    if ! git -C "$repository" diff --quiet HEAD -- "${paths[@]}" ||
        [ -n "$(git -C "$repository" ls-files --others --exclude-standard -- "${paths[@]}")" ]; then
        echo "error: oracle build inputs are dirty; commit before building or verifying" >&2
        return 1
    fi
    # Include names and object types as well as hashes. This includes dependency
    # selection and all local production crates, not only the public wrapper.
    git -C "$repository" ls-tree HEAD -- "${paths[@]}"
}
