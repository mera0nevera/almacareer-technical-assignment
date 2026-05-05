<?php
require_once __DIR__ . '/config.php';

$hostname  = gethostname();
$db_status = 'error';
$db_error  = '';
$visits    = [];

try {
    $dsn = sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', DB_HOST, DB_NAME);
    $pdo = new PDO($dsn, DB_USER, DB_PASS, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_TIMEOUT => 3,
    ]);
    $pdo->prepare('INSERT INTO visits (server_hostname, visited_at) VALUES (?, NOW())')
        ->execute([$hostname]);
    $stmt  = $pdo->query('SELECT server_hostname, visited_at FROM visits ORDER BY id DESC LIMIT 10');
    $visits = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $db_status = 'ok';
} catch (PDOException $e) {
    $db_error = htmlspecialchars($e->getMessage());
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>LMC App – <?= htmlspecialchars($hostname) ?></title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Courier New', monospace; background: #0d1117; color: #c9d1d9; padding: 2rem; }
        h1 { color: #58a6ff; margin-bottom: 1.5rem; }
        h3 { color: #8b949e; margin-bottom: .75rem; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; }
        .card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 1.25rem; margin-bottom: 1rem; }
        .ok  { border-left: 3px solid #3fb950; }
        .err { border-left: 3px solid #f85149; }
        p { line-height: 1.8; }
        strong { color: #e6edf3; }
        .badge { display: inline-block; padding: 1px 8px; border-radius: 12px; font-size: .8rem; font-weight: bold; }
        .badge-ok  { background: #1a4731; color: #3fb950; }
        .badge-err { background: #4d1212; color: #f85149; }
        table { width: 100%; border-collapse: collapse; font-size: .9rem; }
        th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #30363d; }
        th { color: #58a6ff; }
    </style>
</head>
<body>
<h1>&#9881; LMC Application</h1>
<div class="card">
    <h3>Server</h3>
    <p><strong>Hostname:</strong> <?= htmlspecialchars($hostname) ?></p>
    <p><strong>PHP Version:</strong> <?= PHP_VERSION ?></p>
    <p><strong>Server Time:</strong> <?= date('Y-m-d H:i:s T') ?></p>
</div>
<div class="card <?= $db_status === 'ok' ? 'ok' : 'err' ?>">
    <h3>Database</h3>
    <p><strong>Status:</strong> <span class="badge badge-<?= $db_status ?>"><?= strtoupper($db_status) ?></span></p>
    <p><strong>Host:</strong> <?= htmlspecialchars(DB_HOST) ?></p>
    <?php if ($db_error): ?><p style="color:#f85149;margin-top:.5rem"><?= $db_error ?></p><?php endif; ?>
</div>
<?php if ($visits): ?>
<div class="card">
    <h3>Last 10 Visits</h3>
    <table>
        <tr><th>Server</th><th>Time (UTC)</th></tr>
        <?php foreach ($visits as $v): ?>
        <tr>
            <td><?= htmlspecialchars($v['server_hostname']) ?></td>
            <td><?= htmlspecialchars($v['visited_at']) ?></td>
        </tr>
        <?php endforeach; ?>
    </table>
</div>
<?php endif; ?>
</body>
</html>
