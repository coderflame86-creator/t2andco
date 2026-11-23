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

$rawUri     = !empty($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : (getenv('REQUEST_URI') ?: '/');
$requestUri = parse_url($rawUri, PHP_URL_PATH);
$rawScript  = !empty($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : (getenv('SCRIPT_NAME') ?: '');
$rawScript  = str_replace('\\', '/', $rawScript);
$scriptParts = explode('/', trim($rawScript, '/'));
array_pop($scriptParts);
$scriptDir  = implode('/', $scriptParts);

// Strip script directory if running in a subdirectory (e.g. /t2andco)
$cleanPath = trim($requestUri, '/');
if (!empty($scriptDir) && str_starts_with($cleanPath, $scriptDir)) {
    $cleanPath = trim(substr($cleanPath, strlen($scriptDir)), '/');
}

// -------------------------------------------------------------
// Helper: Proxy to Node.js backend if available on port 3000
// -------------------------------------------------------------
function tryProxyToNode($path, $rawInput = '') {
    if (!extension_loaded('curl')) return null;
    $nodeUrl = 'http://127.0.0.1:3000/' . $path;
    $ch = curl_init($nodeUrl);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $_SERVER['REQUEST_METHOD']);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT_MS, 150);
    curl_setopt($ch, CURLOPT_TIMEOUT_MS, 3000);
    curl_setopt($ch, CURLOPT_NOSIGNAL, 1);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    
    // Forward headers
    $headers = [];
    if (isset($_SERVER['CONTENT_TYPE'])) $headers[] = 'Content-Type: ' . $_SERVER['CONTENT_TYPE'];
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (empty($auth) && function_exists('apache_request_headers')) {
        $reqH = apache_request_headers();
        $auth = $reqH['Authorization'] ?? $reqH['authorization'] ?? '';
    }
    if (!empty($auth)) $headers[] = 'Authorization: ' . $auth;
    if (isset($_SERVER['HTTP_COOKIE'])) $headers[] = 'Cookie: ' . $_SERVER['HTTP_COOKIE'];
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

    if (in_array($_SERVER['REQUEST_METHOD'], ['POST', 'PUT', 'PATCH'])) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $rawInput);
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
    $rawInput = file_get_contents('php://input');

    // Attempt proxy to local Node server first
    tryProxyToNode($cleanPath, $rawInput);

    header('Content-Type: application/json; charset=UTF-8');
    $input = json_decode($rawInput, true) ?: [];

    // Session directory for both owner login sessions and order sessions
    $sessionDir = __DIR__ . '/data/sessions';
    if (!is_dir($sessionDir)) @mkdir($sessionDir, 0755, true);

    // ---------------------------------------------------------
    // Owner API Routes (Dashboard Backend)
    // ---------------------------------------------------------
    if (str_starts_with($cleanPath, 'owner/api')) {
        $ownerSubPath = str_replace('owner/api', '', $cleanPath);
        $ownerSubPath = '/' . ltrim($ownerSubPath, '/');

        $accounts = [];
        if (!empty($env['OWNER_USERNAME']) && !empty($env['OWNER_PASSWORD_HASH'])) {
            $accounts[] = ['username' => $env['OWNER_USERNAME'], 'hash' => $env['OWNER_PASSWORD_HASH']];
        }
        if (!empty($env['OWNER_USERNAME']) && !empty($env['OWNER_PASSWORD'])) {
            $accounts[] = ['username' => $env['OWNER_USERNAME'], 'pass' => $env['OWNER_PASSWORD']];
        }
        if (!empty($env['OWNER2_USERNAME']) && !empty($env['OWNER2_PASSWORD_HASH'])) {
            $accounts[] = ['username' => $env['OWNER2_USERNAME'], 'hash' => $env['OWNER2_PASSWORD_HASH']];
        }
        if (!empty($env['OWNER2_USERNAME']) && !empty($env['OWNER2_PASSWORD'])) {
            $accounts[] = ['username' => $env['OWNER2_USERNAME'], 'pass' => $env['OWNER2_PASSWORD']];
        }
        for ($i = 3; $i <= 10; $i++) {
            if (!empty($env["OWNER{$i}_USERNAME"]) && !empty($env["OWNER{$i}_PASSWORD_HASH"])) {
                $accounts[] = ['username' => $env["OWNER{$i}_USERNAME"], 'hash' => $env["OWNER{$i}_PASSWORD_HASH"]];
            }
            if (!empty($env["OWNER{$i}_USERNAME"]) && !empty($env["OWNER{$i}_PASSWORD"])) {
                $accounts[] = ['username' => $env["OWNER{$i}_USERNAME"], 'pass' => $env["OWNER{$i}_PASSWORD"]];
            }
        }

        // Support session token via cookie or Authorization header
        $sessionToken = '';
        if (!empty($_COOKIE['t2co_owner'])) {
            $sessionToken = $_COOKIE['t2co_owner'];
        }
        $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if (empty($authHeader) && function_exists('apache_request_headers')) {
            $apacheH = apache_request_headers();
            $authHeader = $apacheH['Authorization'] ?? $apacheH['authorization'] ?? '';
        }
        if (empty($sessionToken) && !empty($authHeader) && preg_match('/Bearer\s+(\S+)/i', $authHeader, $m)) {
            $sessionToken = $m[1];
        }

        $sessionToken = preg_replace('/[^a-zA-Z0-9_-]/', '', $sessionToken);
        $ownerSessionFile = !empty($sessionToken) ? $sessionDir . '/owner_' . $sessionToken . '.tmp' : null;
        $isLoggedIn = $ownerSessionFile && file_exists($ownerSessionFile) && (time() - filemtime($ownerSessionFile) < 12 * 3600);
        $configured = count($accounts) > 0;

        if ($ownerSubPath === '/session') {
            echo json_encode(['loggedIn' => $isLoggedIn, 'configured' => $configured]);
            exit;
        }

        if ($ownerSubPath === '/login') {
            $username = trim($input['username'] ?? '');
            $password = $input['password'] ?? '';
            $valid = false;

            foreach ($accounts as $acc) {
                if (strcasecmp($acc['username'], $username) === 0) {
                    if (isset($acc['pass']) && hash_equals($acc['pass'], $password)) {
                        $valid = true;
                        break;
                    }
                    if (isset($acc['hash'])) {
                        $h = $acc['hash'];
                        if (str_starts_with($h, 'sha256:')) {
                            $parts = explode(':', $h);
                            if (count($parts) === 3) {
                                $expected = hash('sha256', $parts[1] . $password);
                                if (hash_equals($parts[2], $expected)) {
                                    $valid = true;
                                    break;
                                }
                            }
                        } elseif (str_starts_with($h, 'scrypt:')) {
                            $parts = explode(':', $h);
                            if (count($parts) === 6) {
                                $salt = $parts[4];
                                $expectedHash = $parts[5];
                                $nodeCheck = @shell_exec("node -e \"const c=require('crypto'); const h=c.scryptSync(".json_encode($password).", Buffer.from(".json_encode($salt).",'hex'), 64, {N:16384,r:8,p:1}); process.stdout.write(h.toString('hex'));\"");
                                if (!empty($nodeCheck) && hash_equals($expectedHash, trim($nodeCheck))) {
                                    $valid = true;
                                    break;
                                }
                            }
                        } elseif (password_verify($password, $h)) {
                            $valid = true;
                            break;
                        }
                    }
                }
            }

            if (!$valid) {
                http_response_code(401);
                echo json_encode(['error' => 'Incorrect username or password.']);
                exit;
            }

            $token = bin2hex(random_bytes(24));
            file_put_contents($sessionDir . '/owner_' . $token . '.tmp', (string)time());
            setcookie('t2co_owner', $token, [
                'expires' => time() + 12 * 3600,
                'path' => '/',
                'httponly' => true,
                'samesite' => 'Lax'
            ]);
            header('Set-Cookie: t2co_owner=' . $token . '; Path=/; Max-Age=' . (12 * 3600) . '; HttpOnly; SameSite=Lax', false);
            echo json_encode(['ok' => true, 'token' => $token]);
            exit;
        }

        if ($ownerSubPath === '/logout') {
            if ($ownerSessionFile && file_exists($ownerSessionFile)) @unlink($ownerSessionFile);
            setcookie('t2co_owner', '', ['expires' => time() - 3600, 'path' => '/']);
            header('Set-Cookie: t2co_owner=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax', false);
            echo json_encode(['ok' => true]);
            exit;
        }

        if (!$isLoggedIn) {
            http_response_code(401);
            echo json_encode(['error' => 'Not logged in.']);
            exit;
        }

        $ordersJsonPath = __DIR__ . '/data/orders.json';
        $allOrders = file_exists($ordersJsonPath) ? json_decode(file_get_contents($ordersJsonPath), true) ?: [] : [];

        if ($ownerSubPath === '/orders') {
            $formatted = array_map(function($ord) {
                $ord['hasReceipt'] = !empty($ord['receiptFile']);
                unset($ord['receiptHash']);
                return $ord;
            }, $allOrders);
            echo json_encode(['orders' => $formatted]);
            exit;
        }

        if (preg_match('#^/orders/([^/]+)/receipt$#', $ownerSubPath, $m)) {
            $orderId = $m[1];
            $receiptPath = __DIR__ . '/data/receipts/' . $orderId . '.jpg';
            if (!file_exists($receiptPath)) $receiptPath = __DIR__ . '/data/receipts/' . $orderId . '.png';
            if (!file_exists($receiptPath)) {
                http_response_code(404);
                echo json_encode(['error' => 'Receipt not found.']);
                exit;
            }
            header('Content-Type: image/jpeg');
            readfile($receiptPath);
            exit;
        }

        if (preg_match('#^/orders/([^/]+)/complete$#', $ownerSubPath, $m)) {
            $orderId = $m[1];
            $isComplete = !empty($input['complete']);
            $foundOrder = null;
            foreach ($allOrders as &$ord) {
                if ($ord['orderId'] === $orderId) {
                    $ord['completedAt'] = $isComplete ? date('c') : null;
                    $foundOrder = $ord;
                    break;
                }
            }
            file_put_contents($ordersJsonPath, json_encode($allOrders, JSON_PRETTY_PRINT));
            if ($foundOrder) {
                $foundOrder['hasReceipt'] = !empty($foundOrder['receiptFile']);
                unset($foundOrder['receiptHash']);
                echo json_encode(['order' => $foundOrder]);
            } else {
                http_response_code(404);
                echo json_encode(['error' => 'Order not found.']);
            }
            exit;
        }
    }

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
if ($cleanPath === 'owner' || $cleanPath === 'owner/' || $cleanPath === 'owner/index.php') {
    $cleanPath = 'owner/index.html';
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
