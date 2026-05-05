<?php
require_once __DIR__ . '/config.php';

$checks  = ['php' => 'ok', 'hostname' => gethostname()];
$overall = 'ok';

try {
    $dsn = sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', DB_HOST, DB_NAME);
    $pdo = new PDO($dsn, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 3]);
    $pdo->query('SELECT 1');
    $checks['database'] = 'ok';
} catch (PDOException $e) {
    $checks['database'] = 'error';
    $overall = 'degraded';
}

$checks['timestamp'] = date('c');
http_response_code($overall === 'ok' ? 200 : 503);
header('Content-Type: application/json');
echo json_encode(['status' => $overall, 'checks' => $checks], JSON_PRETTY_PRINT);
