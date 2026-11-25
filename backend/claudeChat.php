<?php
/**
 * T2&Co - Native PHP Claude Chat Engine
 * Handles AI chat, Claude Tool Calling, in-chat order management, receipt uploads,
 * and order submission via the Anthropic Messages API without requiring Node.js.
 */

if (!defined('T2CO_ROUTER')) {
    define('T2CO_ROUTER', true);
}

function formatMenuForClaude($menu) {
    $skinTypes = "### Skin types\n" . implode("\n", array_map(function($s) {
        return "- {$s['id']} = {$s['label']}";
    }, $menu['skinTypes'] ?? []));

    $categories = array_map(function($cat) use ($menu) {
        $items = array_filter($menu['items'] ?? [], function($item) use ($cat) {
            return ($item['category'] ?? '') === $cat['id'];
        });
        $itemTexts = array_map(function($item) use ($menu) {
            $currency = $menu['currency'] ?? 'PKR';
            $sizes = array_filter(array_map(function($o) { return $o['size'] ?? ''; }, $item['options'] ?? []));
            $optList = implode(', ', array_map(function($o) {
                return "{$o['id']} = " . ($o['label'] ?? '');
            }, $item['options'] ?? []));
            $aliases = !empty($item['aliases']) ? implode(', ', $item['aliases']) : 'none';
            $price = $currency . ' ' . number_format($item['price']);
            $avail = !empty($item['available']) ? 'In stock' : 'Out of stock';
            $sizeStr = !empty($sizes) ? implode(', ', $sizes) : 'not confirmed';
            $benefits = !empty($item['benefits']) ? implode(', ', $item['benefits']) : 'none';
            $actives = !empty($item['activeIngredients']) ? implode(', ', $item['activeIngredients']) : 'none';
            $ingredients = $item['ingredients'] ?? 'not confirmed';

            return implode("\n", [
                "#### {$item['name']}",
                "- Product id: {$item['id']} (options: {$optList})",
                "- Other names: {$aliases}",
                "- Price: {$price}",
                "- Availability: {$avail}",
                "- Size: {$sizeStr}",
                "- Made in: " . ($item['origin'] ?? 'Japan'),
                "- What it does: " . ($item['description'] ?? ''),
                "- Benefits: {$benefits}",
                "- Key actives: {$actives}",
                "- Full ingredients: {$ingredients}"
            ]);
        }, $items);

        return "### {$cat['name']}\n\n" . implode("\n\n", $itemTexts);
    }, $menu['categories'] ?? []);

    return implode("\n\n", array_merge($categories, [$skinTypes]));
}

function getClaudeSystemPrompt($env, $menu) {
    $promptFile = __DIR__ . '/../prompts/system-prompt.md';
    $template = file_exists($promptFile) ? file_get_contents($promptFile) : '';
    if (empty($template)) {
        return "You are T2&Co Bot, a helpful skincare assistant for T2&Co in Pakistan.";
    }

    $formattedMenu = formatMenuForClaude($menu);
    $prompt = str_replace('{{MENU}}', $formattedMenu, $template);
    
    $prompt = str_replace('{{BANK_ACCOUNT_NAME}}', $env['BANK_ACCOUNT_NAME'] ?? 'Tanvir Maqsood', $prompt);
    $prompt = str_replace('{{BANK_NAME}}', $env['BANK_NAME'] ?? 'Habib Metro Bank', $prompt);
    $prompt = str_replace('{{BANK_ACCOUNT_NUMBER}}', $env['BANK_ACCOUNT_NUMBER'] ?? '6-1-19-20311-714-130065', $prompt);
    $prompt = str_replace('{{BANK_IBAN}}', $env['BANK_IBAN'] ?? 'PK52 MPBL 0119 0271 4013 0065', $prompt);

    return $prompt;
}

function getClaudeOrderTools() {
    return [
        [
            'name' => 'add_to_order',
            'description' => "Add one menu item to the customer's order. Call it once per product the customer wants to add. Adding a product that is already in the order increases its quantity. If the result says an option is needed, ask the customer to choose from the listed options, then call again with that optionId. The result has the correct prices and total: only quote totals from it.",
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'productId' => ['type' => 'string', 'description' => 'Product id from the MENU, e.g. aa-retinol.'],
                    'optionId' => ['type' => 'string', 'description' => 'Option id from the MENU. Leave out only if the product has one option.'],
                    'quantity' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 20, 'description' => 'How many to add. Defaults to 1.']
                ],
                'required' => ['productId']
            ]
        ],
        [
            'name' => 'update_order_item',
            'description' => "Change an item that is already in the order: set its quantity (the new total, not an amount to add), record the customer's skin type for it, or switch it to another option from the MENU. Send only what changes. The result has the correct prices and total: only quote totals from it.",
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'productId' => ['type' => 'string', 'description' => 'Product id of the item in the order.'],
                    'optionId' => ['type' => 'string', 'description' => 'Current option id. Needed only if the product is in the order in several options.'],
                    'quantity' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 20, 'description' => 'The new quantity for this item.'],
                    'skinType' => ['type' => 'string', 'description' => "Skin type id from the MENU's Skin types list."],
                    'newOptionId' => ['type' => 'string', 'description' => 'Option id from the MENU to switch this item to.']
                ],
                'required' => ['productId']
            ]
        ],
        [
            'name' => 'remove_from_order',
            'description' => "Remove an item from the order, or reduce its quantity. Leave out quantity to remove the item completely; give quantity to take that many out. The result has the correct prices and total: only quote totals from it.",
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'productId' => ['type' => 'string', 'description' => 'Product id of the item in the order.'],
                    'optionId' => ['type' => 'string', 'description' => 'Option id. Needed only if the product is in the order in several options.'],
                    'quantity' => ['type' => 'integer', 'minimum' => 1, 'description' => 'How many to take out. Leave out to remove the item completely.']
                ],
                'required' => ['productId']
            ]
        ],
        [
            'name' => 'clear_order',
            'description' => "Remove every item from the order, when the customer clearly wants to cancel the whole order or start over. Not for removing one item (use remove_from_order). Can't be used after the order is submitted.",
            'input_schema' => ['type' => 'object', 'properties' => new stdClass()]
        ],
        [
            'name' => 'confirm_order',
            'description' => "Mark the order as confirmed. Call it only after you showed the customer the full order summary and total and they explicitly said yes. Pass the total they agreed to.",
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'customerConfirmedTotal' => ['type' => 'number', 'description' => 'The total the customer agreed to.']
                ],
                'required' => ['customerConfirmedTotal']
            ]
        ],
        [
            'name' => 'save_customer_details',
            'description' => "Save the customer's delivery details after the order is confirmed. Send whichever details the customer has given; call again for the rest. The result lists any details still missing.",
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'name' => ['type' => 'string', 'description' => 'Full name.'],
                    'email' => ['type' => 'string'],
                    'whatsapp' => ['type' => 'string', 'description' => 'Active WhatsApp number.'],
                    'address' => ['type' => 'string', 'description' => 'Full delivery address (house, street, area).'],
                    'city' => ['type' => 'string'],
                    'emailOffers' => ['type' => 'boolean', 'description' => 'true only if customer clearly said yes to email offers; false if they said no.']
                ]
            ]
        ]
    ];
}

function recalcClaudeOrder(&$order) {
    $sub = 0;
    foreach ($order['items'] as &$it) {
        $it['lineTotal'] = ($it['unitPrice'] ?? 0) * ($it['quantity'] ?? 1);
        $sub += $it['lineTotal'];
    }
    $order['subtotal'] = $sub;
    $order['total'] = max(0, $sub - ($order['discount'] ?? 0));

    $hasDetails = !empty($order['customer']['name']) &&
                  !empty($order['customer']['email']) &&
                  !empty($order['customer']['whatsapp']) &&
                  !empty($order['customer']['address']) &&
                  !empty($order['customer']['city']);

    if (!empty($order['submittedAt'])) {
        $order['status'] = 'submitted';
    } elseif (empty($order['items'])) {
        $order['status'] = 'browsing';
    } elseif (empty($order['confirmed'])) {
        $order['status'] = 'draft';
    } elseif (!$hasDetails) {
        $order['status'] = 'awaiting_details';
    } else {
        $order['status'] = 'awaiting_payment';
    }
}

function summarizeClaudeOrder($order, $menu) {
    if (empty($order['items'])) return 'Your order is empty.';
    $lines = [];
    $currency = $order['currency'] ?? 'PKR';
    foreach ($order['items'] as $item) {
        $details = [];
        if (!empty($item['optionLabel']) && $item['optionLabel'] !== 'Standard') {
            $details[] = $item['optionLabel'];
        } elseif (!empty($item['size'])) {
            $details[] = $item['size'];
        }
        if (!empty($item['skinType'])) {
            $skinLabel = $item['skinType'];
            foreach ($menu['skinTypes'] ?? [] as $st) {
                if ($st['id'] === $item['skinType']) { $skinLabel = $st['label']; break; }
            }
            $details[] = "for {$skinLabel}";
        }
        $extra = !empty($details) ? ' (' . implode(', ', $details) . ')' : '';
        $lines[] = "- {$item['quantity']} x {$item['name']}{$extra}: {$currency} " . number_format($item['lineTotal']);
    }
    $lines[] = "Total: {$currency} " . number_format($order['total']);
    return implode("\n", $lines);
}

function executeClaudeTool(&$order, $toolName, $input, $menu) {
    if (!empty($order['submittedAt'])) {
        return ['ok' => false, 'error' => "This order was already submitted as {$order['orderId']} and can't be changed in chat. The T2&Co team can help with changes."];
    }

    if ($toolName === 'add_to_order') {
        $productId = $input['productId'] ?? '';
        $quantity = max(1, min(20, (int)($input['quantity'] ?? 1)));
        $found = null;
        foreach ($menu['items'] as $it) {
            if ($it['id'] === $productId) { $found = $it; break; }
        }
        if (!$found) return ['ok' => false, 'error' => "Unknown productId \"{$productId}\". Use a product id from the MENU."];
        if (empty($found['available'])) return ['ok' => false, 'error' => "{$found['name']} is out of stock."];

        $optionId = $input['optionId'] ?? null;
        $options = $found['options'] ?? [];
        if (empty($optionId)) {
            if (count($options) === 1) {
                $option = $options[0];
            } else {
                return [
                    'ok' => false,
                    'error' => "{$found['name']} comes in several options. Ask the customer which one they want.",
                    'needsOption' => $options
                ];
            }
        } else {
            $option = null;
            foreach ($options as $opt) {
                if ($opt['id'] === $optionId) { $option = $opt; break; }
            }
            if (!$option) return ['ok' => false, 'error' => "Unknown optionId \"{$optionId}\" for {$found['name']}."];
        }

        $existing = false;
        foreach ($order['items'] as &$line) {
            if ($line['productId'] === $found['id'] && $line['optionId'] === $option['id']) {
                $line['quantity'] = min(20, $line['quantity'] + $quantity);
                $existing = true;
                break;
            }
        }
        if (!$existing) {
            $order['items'][] = [
                'productId' => $found['id'],
                'name' => $found['name'],
                'optionId' => $option['id'],
                'optionLabel' => $option['label'],
                'size' => $option['size'] ?? '',
                'unitPrice' => $option['price'],
                'quantity' => $quantity,
                'lineTotal' => $option['price'] * $quantity,
                'skinType' => null
            ];
        }
        recalcClaudeOrder($order);
        return ['ok' => true, 'added' => ['name' => $found['name'], 'quantity' => $quantity, 'option' => $option['label']]];
    }

    if ($toolName === 'update_order_item') {
        $productId = $input['productId'] ?? '';
        $found = null;
        foreach ($order['items'] as &$line) {
            if ($line['productId'] === $productId) { $found = &$line; break; }
        }
        if (!$found) return ['ok' => false, 'error' => "That product is not in the order."];

        if (isset($input['quantity'])) {
            $found['quantity'] = max(1, min(20, (int)$input['quantity']));
        }
        if (isset($input['skinType'])) {
            $found['skinType'] = $input['skinType'];
        }
        if (isset($input['newOptionId'])) {
            foreach ($menu['items'] as $item) {
                if ($item['id'] === $productId) {
                    foreach ($item['options'] ?? [] as $opt) {
                        if ($opt['id'] === $input['newOptionId']) {
                            $found['optionId'] = $opt['id'];
                            $found['optionLabel'] = $opt['label'];
                            $found['size'] = $opt['size'] ?? '';
                            $found['unitPrice'] = $opt['price'];
                            break;
                        }
                    }
                    break;
                }
            }
        }
        recalcClaudeOrder($order);
        return ['ok' => true, 'updated' => $found];
    }

    if ($toolName === 'remove_from_order') {
        $productId = $input['productId'] ?? '';
        $qty = isset($input['quantity']) ? (int)$input['quantity'] : null;
        $removed = null;
        foreach ($order['items'] as $idx => &$line) {
            if ($line['productId'] === $productId) {
                if ($qty === null || $qty >= $line['quantity']) {
                    $removed = $line;
                    array_splice($order['items'], $idx, 1);
                } else {
                    $line['quantity'] -= $qty;
                    $removed = ['name' => $line['name'], 'quantity' => $qty];
                }
                break;
            }
        }
        if (!$removed) return ['ok' => false, 'error' => "That product is not in the order."];
        recalcClaudeOrder($order);
        return ['ok' => true, 'removed' => $removed];
    }

    if ($toolName === 'clear_order') {
        $order['items'] = [];
        $order['confirmed'] = false;
        $order['confirmedAt'] = null;
        recalcClaudeOrder($order);
        return ['ok' => true, 'order' => 'cleared'];
    }

    if ($toolName === 'confirm_order') {
        if (empty($order['items'])) return ['ok' => false, 'error' => "The order is empty."];
        $customerTotal = (float)($input['customerConfirmedTotal'] ?? 0);
        if (abs($customerTotal - $order['total']) > 0.01) {
            $currency = $order['currency'] ?? 'PKR';
            return ['ok' => false, 'error' => "The total is {$currency} " . number_format($order['total']) . ". Repeat the order and this total to the customer and ask again."];
        }
        $order['confirmed'] = true;
        $order['confirmedAt'] = date('c');
        recalcClaudeOrder($order);
        return ['ok' => true, 'confirmed' => true];
    }

    if ($toolName === 'save_customer_details') {
        if (empty($order['confirmed'])) {
            return ['ok' => false, 'error' => "Confirm the order and total with the customer before taking their details."];
        }
        $c = &$order['customer'];
        if (!empty($input['name'])) $c['name'] = trim($input['name']);
        if (!empty($input['email'])) $c['email'] = strtolower(trim($input['email']));
        if (!empty($input['whatsapp'])) $c['whatsapp'] = preg_replace('/[^\d+]/', '', trim($input['whatsapp']));
        if (!empty($input['address'])) $c['address'] = trim($input['address']);
        if (!empty($input['city'])) $c['city'] = trim($input['city']);
        if (isset($input['emailOffers'])) $order['emailOffers'] = (bool)$input['emailOffers'];

        recalcClaudeOrder($order);

        $missing = [];
        foreach (['name', 'email', 'whatsapp', 'address', 'city'] as $f) {
            if (empty($c[$f])) $missing[] = $f;
        }
        return ['ok' => true, 'missing' => $missing, 'customer' => $c];
    }

    return ['ok' => false, 'error' => "Unknown tool: {$toolName}"];
}

function sendOrderEmailsPhp($order, $env) {
    $smtpUser = $env['SMTP_USER'] ?? '';
    $smtpPass = $env['SMTP_PASS'] ?? '';
    if (empty($smtpUser) || empty($smtpPass)) return;

    $host = 'ssl://smtp.gmail.com';
    $port = 465;
    $socket = @fsockopen($host, $port, $errno, $errstr, 5);
    if (!$socket) return;

    $read = function() use ($socket) {
        $data = '';
        while ($str = fgets($socket, 515)) {
            $data .= $str;
            if (substr($str, 3, 1) === ' ') break;
        }
        return $data;
    };
    $send = function($cmd) use ($socket, $read) {
        fputs($socket, $cmd . "\r\n");
        return $read();
    };

    $init = $read();
    if (!str_starts_with($init, '220')) { fclose($socket); return; }

    $send("EHLO localhost");
    $send("AUTH LOGIN");
    $send(base64_encode(str_replace(' ', '', $smtpUser)));
    $send(base64_encode(str_replace(' ', '', $smtpPass)));

    $ownerEmail = $env['OWNER_EMAIL'] ?? $smtpUser;
    $from = $env['EMAIL_FROM'] ?? $smtpUser;
    $itemsList = [];
    foreach ($order['items'] as $i) {
        $itemsList[] = "  - {$i['quantity']} x {$i['name']}: {$order['currency']} " . number_format($i['lineTotal']);
    }
    $itemsText = implode("\r\n", $itemsList);

    // 1. Send owner notification
    $send("MAIL FROM:<$smtpUser>");
    $send("RCPT TO:<$ownerEmail>");
    $send("DATA");
    $ownerBody = "New order {$order['orderId']}\r\nPlaced on " . date('r') . " via chat.\r\n\r\n"
               . "Customer:\r\n"
               . "  Name: " . ($order['customer']['name'] ?? 'N/A') . "\r\n"
               . "  WhatsApp: " . ($order['customer']['whatsapp'] ?? 'N/A') . "\r\n"
               . "  Address: " . ($order['customer']['address'] ?? '') . ", " . ($order['customer']['city'] ?? '') . "\r\n\r\n"
               . "Items:\r\n{$itemsText}\r\n"
               . "Total: {$order['currency']} " . number_format($order['total']) . "\r\n\r\n"
               . "Check payment in bank and mark complete in owner dashboard.";
    $send("From: $from\r\nTo: $ownerEmail\r\nSubject: New T2&Co Order {$order['orderId']}\r\n\r\n" . $ownerBody . "\r\n.");

    // 2. Send customer confirmation if email present
    if (!empty($order['customer']['email'])) {
        $cEmail = $order['customer']['email'];
        $send("MAIL FROM:<$smtpUser>");
        $send("RCPT TO:<$cEmail>");
        $send("DATA");
        $custBody = "Dear " . ($order['customer']['name'] ?? 'Customer') . ",\r\n\r\n"
                  . "Thank you for shopping with T2&Co! We have received your order {$order['orderId']}.\r\n\r\n"
                  . "Items:\r\n{$itemsText}\r\n"
                  . "Total: {$order['currency']} " . number_format($order['total']) . "\r\n\r\n"
                  . "Our team will check your payment and message you on WhatsApp. Delivery in 5-7 working days.\r\n\r\n"
                  . "T2&Co - Bringing the best of Japan to you.";
        $send("From: $from\r\nTo: $cEmail\r\nSubject: Your T2&Co Order {$order['orderId']}\r\n\r\n" . $custBody . "\r\n.");
    }

    $send("QUIT");
    fclose($socket);
}

function handleClaudeChat($input, $sessionId, &$order, $sessionFile, $env, $menu) {
    $apiKey = $env['ANTHROPIC_API_KEY'] ?? '';
    if (empty($apiKey)) {
        return [
            'ok' => false,
            'reply' => "Chat is currently offline (API key not configured). Please WhatsApp us on 0323 0955496.",
            'sessionId' => $sessionId,
            'order' => $order,
            'summary' => summarizeClaudeOrder($order, $menu)
        ];
    }

    $serverNote = null;

    // Handle uploaded payment receipt image
    if (!empty($input['image']) && is_array($input['image'])) {
        if ($order['status'] !== 'awaiting_payment') {
            $serverNote = "The customer uploaded an image as a payment receipt, but it was NOT saved because the order is not ready for payment (status: {$order['status']}). Explain kindly what is still needed first.";
        } else {
            $receiptData = $input['image']['data'] ?? '';
            $orderId = 'T2-' . date('Ymd') . '-' . strtoupper(bin2hex(random_bytes(3)));
            $receiptDir = __DIR__ . '/../data/receipts';
            if (!is_dir($receiptDir)) @mkdir($receiptDir, 0755, true);

            $receiptFile = $orderId . '.jpg';
            if (!empty($receiptData)) {
                $decoded = base64_decode($receiptData);
                if ($decoded) file_put_contents($receiptDir . '/' . $receiptFile, $decoded);
            }

            $order['orderId'] = $orderId;
            $order['receiptFile'] = $receiptFile;
            $order['submittedAt'] = date('c');
            $order['source'] = 'chat';
            recalcClaudeOrder($order);

            // Save to data/orders.json
            $ordersJsonPath = __DIR__ . '/../data/orders.json';
            $allOrders = file_exists($ordersJsonPath) ? json_decode(file_get_contents($ordersJsonPath), true) ?: [] : [];
            $allOrders[] = $order;
            file_put_contents($ordersJsonPath, json_encode($allOrders, JSON_PRETTY_PRINT));

            // Send notification emails in background
            sendOrderEmailsPhp($order, $env);

            $serverNote = "Payment receipt received and saved. The order is now submitted with order number {$orderId}. A confirmation email is being sent to {$order['customer']['email']}. Thank the customer, give them the order number, and follow Step 6.";
        }
    }

    $systemPrompt = getClaudeSystemPrompt($env, $menu);
    $tools = getClaudeOrderTools();

    // Prepare messages history
    $rawHistory = $input['conversationHistory'] ?? [];
    $messages = [];
    foreach ($rawHistory as $turn) {
        $role = $turn['role'] ?? '';
        $content = $turn['content'] ?? '';
        if (($role === 'user' || $role === 'assistant') && is_string($content) && trim($content) !== '') {
            $messages[] = ['role' => $role, 'content' => trim($content)];
        }
    }
    while (!empty($messages) && $messages[0]['role'] !== 'user') {
        array_shift($messages);
    }

    // Newest user turn
    $userMsg = trim($input['message'] ?? '');
    if (empty($userMsg)) {
        $userMsg = !empty($input['image']) ? "(I uploaded my payment receipt.)" : "Hello";
    }

    // Append context note to user turn
    $publicOrder = $order;
    unset($publicOrder['receiptFile'], $publicOrder['receiptHash']);
    $noteParts = [];
    if (!empty($serverNote)) $noteParts[] = "Server note: {$serverNote}";
    $noteParts[] = "Current order summary:\n" . summarizeClaudeOrder($order, $menu);
    $noteParts[] = "Current order state:\n" . json_encode($publicOrder);
    $contextNote = implode("\n\n", $noteParts);

    $messages[] = [
        'role' => 'user',
        'content' => $userMsg . "\n\n[System Note:\n" . $contextNote . "]"
    ];

    // Anthropic API tool-calling loop (up to 4 rounds)
    $replyText = '';
    $model = 'claude-haiku-5-5'; // Fast, lightweight, active on user API key

    for ($round = 0; $round < 4; $round++) {
        $payload = [
            'model' => $model,
            'max_tokens' => 2048,
            'system' => $systemPrompt,
            'tools' => $tools,
            'messages' => $messages
        ];

        $ch = curl_init('https://api.anthropic.com/v1/messages');
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 30);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'x-api-key: ' . $apiKey,
            'anthropic-version: 2023-06-01',
            'content-type: application/json'
        ]);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));

        $res = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);

        if ($httpCode !== 200 || empty($res)) {
            error_log("Claude API error: HTTP {$httpCode} - {$err} - {$res}");
            if (empty($replyText)) {
                $replyText = "Sorry, I can't reply right now. Please try again in a moment, or WhatsApp our team on 0323 0955496.";
            }
            break;
        }

        $resData = json_decode($res, true);
        $stopReason = $resData['stop_reason'] ?? '';
        $contentBlocks = $resData['content'] ?? [];

        if ($stopReason === 'tool_use') {
            $toolResults = [];
            foreach ($contentBlocks as $block) {
                if (($block['type'] ?? '') === 'tool_use') {
                    $toolName = $block['name'] ?? '';
                    $toolInput = $block['input'] ?? [];
                    $toolRes = executeClaudeTool($order, $toolName, $toolInput, $menu);
                    $toolResults[] = [
                        'type' => 'tool_result',
                        'tool_use_id' => $block['id'],
                        'content' => json_encode(array_merge($toolRes, [
                            'summary' => summarizeClaudeOrder($order, $menu)
                        ]))
                    ];
                }
            }

            $messages[] = ['role' => 'assistant', 'content' => $contentBlocks];
            $messages[] = ['role' => 'user', 'content' => $toolResults];
            continue;
        }

        // Regular textual reply
        foreach ($contentBlocks as $block) {
            if (($block['type'] ?? '') === 'text') {
                $replyText .= $block['text'];
            }
        }
        break;
    }

    if (empty($replyText)) {
        $replyText = "Thank you for reaching out! How can I help you choose the best skincare product today?";
    }

    // Persist order state
    file_put_contents($sessionFile, json_encode($order, JSON_PRETTY_PRINT));

    return [
        'ok' => true,
        'reply' => trim($replyText),
        'sessionId' => $sessionId,
        'order' => $order,
        'summary' => summarizeClaudeOrder($order, $menu)
    ];
}
