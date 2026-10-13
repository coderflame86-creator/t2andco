# Local preview server for the Claude Code browser panel. Not part of the website.
param([string]$Root = "frontend", [int]$Port = 8080)
$Root = [IO.Path]::GetFullPath((Join-Path (Get-Location) $Root))
$types = @{ '.html'='text/html; charset=utf-8'; '.css'='text/css'; '.js'='application/javascript'; '.svg'='image/svg+xml'; '.webp'='image/webp'; '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.mp4'='video/mp4' }
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
Write-Host "Serving $Root at http://localhost:$Port/"
while ($l.IsListening) {
  $ctx = $l.GetContext()
  try {
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
  if ($path -eq '') { $path = 'index.html' }
  $file = [IO.Path]::GetFullPath((Join-Path $Root $path))
  $ctx.Response.Headers.Add('Cache-Control', 'no-store')
  if ($file.StartsWith($Root) -and (Test-Path $file -PathType Leaf)) {
    $bytes = [IO.File]::ReadAllBytes($file)
    $ext = [IO.Path]::GetExtension($file).ToLower()
    if ($types[$ext]) { $ctx.Response.ContentType = $types[$ext] }
    $ctx.Response.Headers.Add('Accept-Ranges', 'bytes')
    # Range requests let browsers seek and loop video
    $range = $ctx.Request.Headers['Range']
    if ($range -match '^bytes=(\d*)-(\d*)$') {
      $len = $bytes.Length
      if ($Matches[1] -eq '') { $start = [Math]::Max(0, $len - [int64]$Matches[2]); $end = $len - 1 }
      else { $start = [int64]$Matches[1]; $end = if ($Matches[2] -eq '') { $len - 1 } else { [Math]::Min([int64]$Matches[2], $len - 1) } }
      if ($start -ge $len) { $ctx.Response.StatusCode = 416; $ctx.Response.Headers.Add('Content-Range', "bytes */$len") }
      else {
        $ctx.Response.StatusCode = 206
        $ctx.Response.Headers.Add('Content-Range', "bytes $start-$end/$len")
        $ctx.Response.OutputStream.Write($bytes, [int]$start, [int]($end - $start + 1))
      }
    } else {
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } else { $ctx.Response.StatusCode = 404 }
  $ctx.Response.Close()
  } catch {
    # Browser cancelled the request (common with video); keep serving
    try { $ctx.Response.Abort() } catch {}
  }
}
