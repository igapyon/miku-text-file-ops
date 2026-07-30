# CLI Invocation Contract

Status: Accepted operational contract.

Use short command-line options for the operation and workspace root. Supply
the request body as one UTF-8 JSON object on standard input. With `--json`,
standard output contains only one machine-readable response envelope.

## Stream and Exit-Code Contract

- `stdin`: exactly one UTF-8 JSON object without a BOM
- `stdout`: the JSON response envelope when `--json` is present
- `stderr`: CLI usage diagnostics or unexpected process-level messages
- exit `0`: complete success
- exit `1`: useful partial result; inspect results and diagnostics
- exit `2`: CLI, JSON, or request-validation error
- exit `3`: operation failure or unexpected runtime error

Keep stdout and stderr separate. Do not use `2>&1` when another program will
parse stdout as JSON. Capture the exit code immediately after the CLI process
finishes, and inspect the JSON envelope even when the exit code is nonzero.

`--json` selects the output format. It does not change stdin; requests always
come from standard input.

## Portable Temporary-File Workflow

For long requests, multiline text, non-ASCII content, or shells with difficult
quoting rules:

1. Write the request to a collision-resistant temporary file as UTF-8 without
   a BOM.
2. Pass the file to the CLI through stdin.
3. Save stdout and stderr separately.
4. Record the process exit code.
5. Delete temporary request and response files when the caller no longer needs
   them.

Do not expand the JSON file back into a command-line argument. Temporary files
may contain sensitive content; create them with access limited to the current
user where the host allows it.

Relative request paths are resolved under `--root`. Use the project or
workspace root explicitly instead of relying on an unrelated current
directory.

## Windows `cmd.exe`

Input redirection keeps the CLI process exit code directly observable:

```bat
node "<miku-text-file-ops-cli-entrypoint>" ^
  --root "<project-root>" --json read ^
  < "%TEMP%\miku-text-file-ops-request.json" ^
  > "%TEMP%\miku-text-file-ops-response.json" ^
  2> "%TEMP%\miku-text-file-ops-stderr.txt"
set "MIKU_TEXT_FILE_OPS_EXIT=%ERRORLEVEL%"
```

The equivalent `type` pipeline is:

```bat
type "%TEMP%\miku-text-file-ops-request.json" ^
  | node "<miku-text-file-ops-cli-entrypoint>" ^
      --root "<project-root>" --json read ^
  > "%TEMP%\miku-text-file-ops-response.json" ^
  2> "%TEMP%\miku-text-file-ops-stderr.txt"
```

Prefer input redirection when the harness must reliably capture the CLI
process exit code. Pipeline exit-code behavior varies with the host shell and
wrapper.

## PowerShell

Create BOM-free UTF-8 explicitly, then use the `cmd.exe` input-redirection
form above:

```powershell
$requestPath = Join-Path $env:TEMP "miku-text-file-ops-request.json"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText(
  $requestPath,
  '{"items":[{"path":"README.md","full":true}]}',
  $utf8NoBom
)
```

Do not rely on Windows PowerShell defaults that may write UTF-16 or a BOM.
Pass the resulting file path as
`%TEMP%\miku-text-file-ops-request.json` in the preceding `cmd.exe` example.

## Encoding Failures

BOM-bearing UTF-8 stdin and UTF-16 stdin are outside this transport contract.
The CLI returns a request error rather than guessing or replacing invalid
bytes. Japanese and other non-ASCII characters are accepted when the request
file is valid BOM-free UTF-8.

The target text file encoding is a separate product setting. Requests can
select UTF encodings or Windows-31J through `writeAs` and repository policy as
defined in [the specification](./specification.md).
