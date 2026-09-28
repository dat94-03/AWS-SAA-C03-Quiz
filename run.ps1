$ErrorActionPreference = 'Stop'
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://127.0.0.1:4173/')

try {
    $listener.Start()
} catch {
    Write-Error "Could not start the local quiz server on port 4173. Close any existing process using that port and try again. $($_.Exception.Message)"
    exit 1
}

Write-Host 'SAA Practice is running at http://127.0.0.1:4173/' -ForegroundColor Green
Write-Host 'Keep this window open while you study. Press Ctrl+C to stop.'

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $relativePath = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrWhiteSpace($relativePath)) { $relativePath = 'index.html' }

    $filePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $relativePath))
    if (-not $filePath.StartsWith($PSScriptRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        $context.Response.StatusCode = 404
        $context.Response.Close()
        continue
    }

    $contentType = switch ([IO.Path]::GetExtension($filePath).ToLowerInvariant()) {
        '.html' { 'text/html; charset=utf-8' }
        '.css'  { 'text/css; charset=utf-8' }
        '.js'   { 'text/javascript; charset=utf-8' }
        default { 'application/octet-stream' }
    }
    $content = [IO.File]::ReadAllBytes($filePath)
    $context.Response.ContentType = $contentType
    $context.Response.ContentLength64 = $content.Length
    $context.Response.Headers.Add('Cache-Control', 'no-store')
    $context.Response.OutputStream.Write($content, 0, $content.Length)
    $context.Response.Close()
}

$listener.Stop()