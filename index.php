<?php
/**
 * T2&Co Entry Point & Router for Hostinger and Apache
 * Serves static pages from frontend/ directory seamlessly.
 */

$requestUri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$scriptName = $_SERVER['SCRIPT_NAME'] ?? '';
$scriptDir  = dirname($scriptName);

// Strip script directory if running in a subdirectory
$cleanPath = $requestUri;
if ($scriptDir !== '/' && $scriptDir !== '\\' && !empty($scriptDir)) {
    if (strpos($cleanPath, $scriptDir) === 0) {
        $cleanPath = substr($cleanPath, strlen($scriptDir));
    }
}
$cleanPath = trim($cleanPath, '/');

// Default page is index.html
if (empty($cleanPath) || $cleanPath === 'index.php') {
    $cleanPath = 'index.html';
}

$targetFile = __DIR__ . '/frontend/' . $cleanPath;

// If the file exists in frontend/, serve it with the proper MIME type
if (file_exists($targetFile) && !is_dir($targetFile)) {
    $extension = strtolower(pathinfo($targetFile, PATHINFO_EXTENSION));
    $mimeTypes = [
        'html'  => 'text/html; charset=UTF-8',
        'css'   => 'text/css; charset=UTF-8',
        'js'    => 'application/javascript; charset=UTF-8',
        'json'  => 'application/json; charset=UTF-8',
        'svg'   => 'image/svg+xml',
        'png'   => 'image/png',
        'jpg'   => 'image/jpeg',
        'jpeg'  => 'image/jpeg',
        'webp'  => 'image/webp',
        'gif'   => 'image/gif',
        'ico'   => 'image/x-icon',
        'mp4'   => 'video/mp4',
        'woff'  => 'font/woff',
        'woff2' => 'font/woff2',
        'ttf'   => 'font/ttf'
    ];

    if (isset($mimeTypes[$extension])) {
        header('Content-Type: ' . $mimeTypes[$extension]);
    } else {
        $mime = @mime_content_type($targetFile);
        if ($mime) {
            header('Content-Type: ' . $mime);
        }
    }

    header('Content-Length: ' . filesize($targetFile));
    readfile($targetFile);
    exit;
}

// Fallback to frontend/index.html
header('Content-Type: text/html; charset=UTF-8');
readfile(__DIR__ . '/frontend/index.html');
exit;
