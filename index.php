<?php
/**
 * T2&Co - Multi-Environment Router & API Bridge for Apache / Hostinger
 * - Serves frontend static files
 * - Proxies /api/* and /owner/api/* to Node.js backend on port 3000 if running
 * - Provides native PHP fallback for order actions when Node is offline
 */

// Load .env if present
$envFile = __DIR__ . '/.env';
$env = [];
if (file_exists($envFile)) {
    $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) continue;
        if (strpos($line, '=') !== false) {
            [$key, $val] = explode('=', $line, 2);
            $env[trim($key)] = trim($val);
        }
    }
}

$rawUri     = $_SERVER['REQUEST_URI'] ?? $_ENV['REQUEST_URI'] ?? '/';
$requestUri = parse_url($rawUri, PHP_URL_PATH);
$rawScript  = $_SERVER['SCRIPT_NAME'] ?? $_ENV['SCRIPT_NAME'] ?? '';
$scriptName = str_replace('\\', '/', $rawScript);
$scriptDir  = trim(str_replace('\\', '/', dirname($scriptName)), '/');

// Strip script directory if running in a subdirectory (e.g. /t2andco)
$cleanPath = trim($requestUri, '/');
if (!empty($scriptDir) && str_starts_with($cleanPath, $scriptDir)) {
    $cleanPath = trim(substr($cleanPath, strlen($scriptDir)), '/');
}

// -------------------------------------------------------------
// Helper: Proxy to Node.js backend if available on port 3000
// -------------------------------------------------------------
function tryProxyToNode($path) {
    if (!extension_loaded('curl')) return null;
    $nodeUrl = 'http://127.0.0.1:3000/' . $path;
    $ch = curl_init($nodeUrl);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $_SERVER['REQUEST_METHOD']);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT_MS, 300);
    curl_setopt($ch, CURLOPT_TIMEOUT_MS, 4000);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    
    // Forward headers
    $headers = [];
    if (isset($_SERVER['CONTENT_TYPE'])) $headers[] = 'Content-Type: ' . $_SERVER['CONTENT_TYPE'];
    if (isset($_SERVER['HTTP_AUTHORIZATION'])) $headers[] = 'Authorization: ' . $_SERVER['HTTP_AUTHORIZATION'];
    if (isset($_SERVER['HTTP_COOKIE'])) $headers[] = 'Cookie: ' . $_SERVER['HTTP_COOKIE'];
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

    if (in_array($_SERVER['REQUEST_METHOD'], ['POST', 'PUT', 'PATCH'])) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, file_get_contents('php://input'));
    }

    $response = curl_exec($ch);
    $errno = curl_errno($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($errno === 0 && $status > 0) {
        http_response_code($status);
        header('Content-Type: application/json; charset=UTF-8');
        echo $response;
        exit;
    }
    return null;
}

// -------------------------------------------------------------
// Route API Requests
// -------------------------------------------------------------
if (str_starts_with($cleanPath, 'api/') || str_starts_with($cleanPath, 'owner/api')) {
    // Attempt proxy to local Node server first
    tryProxyToNode($cleanPath);

    header('Content-Type: application/json; charset=UTF-8');
    $input = json_decode(file_get_contents('php://input'), true) ?: [];

    // Session handling for native PHP orders
    $sessionDir = __DIR__ . '/data/sessions';
    if (!is_dir($sessionDir)) @mkdir($sessionDir, 0755, true);

    $sessionId = isset($input['sessionId']) && is_string($input['sessionId']) && strlen($input['sessionId']) <= 64
        ? preg_replace('/[^a-zA-Z0-9_-]/', '', $input['sessionId'])
        : bin2hex(random_bytes(16));
    
    $sessionFile = $sessionDir . '/' . $sessionId . '.json';
    $menuFile = __DIR__ . '/data/menu.json';
    $menu = file_exists($menuFile) ? json_decode(file_get_contents($menuFile), true) : ['items' => [], 'currency' => 'PKR'];

    // Load or create order
    if (file_exists($sessionFile)) {
        $order = json_decode(file_get_contents($sessionFile), true);
    } else {
        $order = [
            'orderId' => null,
            'items' => [],
            'orderType' => 'delivery',
            'customer' => ['name' => null, 'email' => null, 'whatsapp' => null, 'address' => null, 'city' => null],
            'emailOffers' => false,
            'promotion' => null,
            'currency' => $menu['currency'] ?? 'PKR',
            'subtotal' => 0,
            'discount' => 0,
            'total' => 0,
            'confirmed' => false,
            'confirmedAt' => null,
            'status' => 'browsing'
        ];
    }

    $recalc = function(&$ord) {
        $sub = 0;
        foreach ($ord['items'] as &$it) {
            $it['lineTotal'] = $it['unitPrice'] * $it['quantity'];
            $sub += $it['lineTotal'];
        }
        $ord['subtotal'] = $sub;
        $ord['total'] = max(0, $sub - ($ord['discount'] ?? 0));
        if (!empty($ord['submittedAt'])) $ord['status'] = 'submitted';
        elseif (empty($ord['items'])) $ord['status'] = 'browsing';
        elseif (!$ord['confirmed']) $ord['status'] = 'draft';
        elseif (empty($ord['customer']['name']) || empty($ord['customer']['email']) || empty($ord['customer']['whatsapp']) || empty($ord['customer']['address'])) {
            $ord['status'] = 'awaiting_details';
        } else {
            $ord['status'] = 'awaiting_payment';
        }
    };

    $summarize = function($ord) {
        if (empty($ord['items'])) return 'Your order is empty.';
        $lines = [];
        foreach ($ord['items'] as $it) {
            $lines[] = "- {$it['quantity']} x {$it['name']}: {$ord['currency']} " . number_format($it['lineTotal']);
        }
        $lines[] = "Total: {$ord['currency']} " . number_format($ord['total']);
        return implode("\n", $lines);
    };

    // Chat endpoint fallback
    if ($cleanPath === 'api/chat') {
        echo json_encode([
            'reply' => "Thank you for reaching out! Please use our Order Now buttons to select products or WhatsApp our team directly at 0323 0955496 for personalized skincare advice.",
            'sessionId' => $sessionId,
            'order' => $order,
            'summary' => $summarize($order)
        ]);
        exit;
    }

    // Payment details endpoint
    if ($cleanPath === 'api/order/payment-details') {
        echo json_encode([
            'ok' => true,
            'sessionId' => $sessionId,
            'order' => $order,
            'summary' => $summarize($order),
            'bank' => [
                'accountName'   => $env['BANK_ACCOUNT_NAME'] ?? 'T2 and Co',
                'bankName'      => $env['BANK_NAME'] ?? 'Meezan Bank',
                'accountNumber' => $env['BANK_ACCOUNT_NUMBER'] ?? '010101020202',
                'iban'          => $env['BANK_IBAN'] ?? 'PK00MEZN0000000000000000'
            ]
        ]);
        exit;
    }

    // Receipt submission endpoint
    if ($cleanPath === 'api/order/receipt') {
        $orderId = 'ORD-' . strtoupper(bin2hex(random_bytes(3)));
        $order['orderId'] = $orderId;
        $order['submittedAt'] = date('c');
        $recalc($order);
        file_put_contents($sessionFile, json_encode($order, JSON_PRETTY_PRINT));
        
        // Save to data/orders.json
        $ordersJsonPath = __DIR__ . '/data/orders.json';
        $allOrders = file_exists($ordersJsonPath) ? json_decode(file_get_contents($ordersJsonPath), true) ?: [] : [];
        $allOrders[] = $order;
        file_put_contents($ordersJsonPath, json_encode($allOrders, JSON_PRETTY_PRINT));

        echo json_encode([
            'ok' => true,
            'orderId' => $orderId,
            'sessionId' => $sessionId,
            'order' => $order,
            'summary' => $summarize($order),
            'confirmationEmail' => false
        ]);
        exit;
    }

    // Order actions (view, add, update, remove, clear, confirm, details)
    $action = str_replace('api/order/', '', $cleanPath);

    if ($action === 'add') {
        $prodId = $input['productId'] ?? '';
        $qty = max(1, (int)($input['quantity'] ?? 1));
        $found = null;
        foreach ($menu['items'] as $item) {
            if ($item['id'] === $prodId) { $found = $item; break; }
        }
        if ($found) {
            $opt = $found['options'][0] ?? ['id' => 'std', 'label' => 'Standard', 'price' => $found['price']];
            $exists = false;
            foreach ($order['items'] as &$it) {
                if ($it['productId'] === $prodId) {
                    $it['quantity'] += $qty;
                    $exists = true;
                    break;
                }
            }
            if (!$exists) {
                $order['items'][] = [
                    'productId' => $found['id'],
                    'name' => $found['name'],
                    'optionId' => $opt['id'],
                    'optionLabel' => $opt['label'],
                    'size' => $opt['size'] ?? '',
                    'unitPrice' => $opt['price'],
                    'quantity' => $qty,
                    'lineTotal' => $opt['price'] * $qty,
                    'skinType' => null
                ];
            }
        }
    } elseif ($action === 'update') {
        $prodId = $input['productId'] ?? '';
        $qty = (int)($input['quantity'] ?? 1);
        foreach ($order['items'] as $idx => &$it) {
            if ($it['productId'] === $prodId) {
                if ($qty <= 0) array_splice($order['items'], $idx, 1);
                else $it['quantity'] = $qty;
                break;
            }
        }
    } elseif ($action === 'remove') {
        $prodId = $input['productId'] ?? '';
        foreach ($order['items'] as $idx => $it) {
            if ($it['productId'] === $prodId) {
                array_splice($order['items'], $idx, 1);
                break;
            }
        }
    } elseif ($action === 'clear') {
        $order['items'] = [];
        $order['confirmed'] = false;
    } elseif ($action === 'confirm') {
        $order['confirmed'] = true;
        $order['confirmedAt'] = date('c');
    } elseif ($action === 'details') {
        $order['customer'] = [
            'name'     => $input['name'] ?? null,
            'email'    => $input['email'] ?? null,
            'whatsapp' => $input['whatsapp'] ?? null,
            'address'  => $input['address'] ?? null,
            'city'     => $input['city'] ?? null
        ];
        $order['emailOffers'] = !empty($input['emailOffers']);
    }

    $recalc($order);
    file_put_contents($sessionFile, json_encode($order, JSON_PRETTY_PRINT));

    echo json_encode([
        'ok' => true,
        'sessionId' => $sessionId,
        'order' => $order,
        'summary' => $summarize($order)
    ]);
    exit;
}

// -------------------------------------------------------------
// Serve Static Frontend Files
// -------------------------------------------------------------
if (empty($cleanPath) || $cleanPath === 'index.php') {
    $cleanPath = 'index.html';
}

$targetFile = __DIR__ . '/frontend/' . $cleanPath;

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
        if ($mime) header('Content-Type: ' . $mime);
    }

    header('Content-Length: ' . filesize($targetFile));
    readfile($targetFile);
    exit;
}

// Default fallback to index.html
header('Content-Type: text/html; charset=UTF-8');
readfile(__DIR__ . '/frontend/index.html');
exit;
