# CTF listing fixture

The D3 CDK test registered 101 real conditions and prepared 202 real keysets.
The test used an isolated SQLite database. It set registration timestamps to
1700000000 for the page boundary check. It reopened the mint and provider.
The HTTP handlers returned two condition pages and three keyset pages.
The captured requests omit `since`. The cursors bind the unfiltered listing.
The fixture retains the actual condition IDs, keyset IDs, and announcements.
This file is test input. It has no runtime dependency on the private repository.

Source SHA-256: `1a71b9fae2d833d15201bc3c024bd7e59b6ca945abad8b47e2a75d07c9230d22`.
