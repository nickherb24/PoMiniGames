# Structural check for every stylesheet the client ships. No dependencies, no build.
#
# It exists because a dead-selector prune can cut selectors out together with the "*/" in
# front of them, which leaves the rule's body attached to the comment and the comment open
# until the NEXT "*/" in the file. Every live rule in between is swallowed, and nothing
# fails: the browser drops what it cannot parse, and a test suite does not look at paint.
#
# Four checks, each one a signature of that damage:
#   1. "/*" inside a comment        - a comment swallowed the comment after it
#   2. a declaration block in a comment - a rule lost its selector to the comment above it
#   3. "*/" outside a comment       - the other end of the same cut
#   4. unbalanced braces            - a rule lost its "}" and nests everything below it
# Check 2 wants the "{" at the end of a line, the shape a real rule has, so a one-line example
# in a comment (`.x { color: red; }`) passes. Commented-out rules trip it on purpose: delete
# them, git keeps the history. A comment must never quote the terminator itself either; two
# notes about this very damage did, and each closed its own comment in mid-sentence.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$clientRoot = Join-Path $repoRoot 'src/PoMiniGames.Client'

$files = Get-ChildItem -Path $clientRoot -Recurse -Filter *.css -File |
    Where-Object { $_.FullName -notmatch '[\\/](bin|obj|lib)[\\/]' }

$problems = [System.Collections.Generic.List[string]]::new()
$commentPattern = [regex]'(?s)/\*.*?\*/'
$blockInComment = [regex]'\{[ \t]*\r?\n\s*[\w-]+\s*:[^;{}]+;'

foreach ($file in $files) {
    $text = [System.IO.File]::ReadAllText($file.FullName)
    $rel = [System.IO.Path]::GetRelativePath($repoRoot, $file.FullName).Replace('\', '/')
    $lineOf = { param($index) ($text.Substring(0, $index) -split "`n").Count }

    foreach ($match in $commentPattern.Matches($text)) {
        $body = $match.Value.Substring(2, $match.Length - 4)
        if ($body.Contains('/*')) {
            $problems.Add("${rel}:$(& $lineOf $match.Index): comment contains '/*' - it swallowed the rules after it")
        }
        elseif ($blockInComment.IsMatch($body)) {
            $problems.Add("${rel}:$(& $lineOf $match.Index): comment contains a declaration block - a rule lost its selector, or CSS is commented out")
        }
    }

    $code = $commentPattern.Replace($text, { param($m) [regex]::Replace($m.Value, '[^\n]', ' ') })
    $stray = $code.IndexOf('*/')
    if ($stray -ge 0) { $problems.Add("${rel}:$(& $lineOf $stray): '*/' outside a comment") }
    if ($code.IndexOf('/*') -ge 0) { $problems.Add("${rel}:$(& $lineOf $code.IndexOf('/*')): comment is never closed") }

    $depth = 0
    for ($i = 0; $i -lt $code.Length; $i++) {
        $ch = $code[$i]
        if ($ch -eq '{') { $depth++ }
        elseif ($ch -eq '}') {
            $depth--
            if ($depth -lt 0) { $problems.Add("${rel}:$(& $lineOf $i): '}' with no open block"); $depth = 0 }
        }
    }
    if ($depth -ne 0) { $problems.Add("${rel}: $depth block(s) never closed") }
}

if ($problems.Count -gt 0) {
    $problems | ForEach-Object { Write-Host "::error::$_" }
    throw "css-lint: $($problems.Count) problem(s) in $($files.Count) stylesheets."
}
Write-Host "css-lint: $($files.Count) stylesheets clean."
