const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, execSync, exec }               = require('child_process');
const { appendFileSync, mkdirSync, existsSync, createWriteStream, renameSync, copyFileSync, readdirSync, statSync, rmSync } = require('fs');
const path   = require('path');
const https  = require('https');
const http   = require('http');

let win;

// ── Версия текущего билда (ОБЯЗАТЕЛЬНО менять при каждом релизе) ──────────────
const CURRENT_VERSION = '1.1.0';

// ── GitHub репо для проверки обновлений ──────────────────────────────────────
// Замени на свой: 'ВАШ_НИК/ВАШ_РЕПО'
const GITHUB_REPO = 'INCFAY/CompPack';

function isAdmin() {
  try { execSync('net session', { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function getLogDir() {
  const d = path.join(app.getPath('userData'), 'logs');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
function writeLog(msg) {
  try {
    const file = path.join(getLogDir(), `install_${new Date().toISOString().split('T')[0]}.log`);
    appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 680,
    resizable: false, frame: false,
    backgroundColor: '#12121f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'appicon.png'),
    show: false,
  });

  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('admin-status', isAdmin());
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

ipcMain.on('minimize',  () => win.minimize());
ipcMain.on('close',     () => app.quit());
ipcMain.on('open-logs', () => shell.openPath(getLogDir()));

ipcMain.on('relaunch-admin', () => {
  const exe = process.execPath;
  exec(`powershell -Command "Start-Process -FilePath '${exe}' -Verb RunAs"`, () => {});
  app.quit();
});

ipcMain.handle('check-installed', async (_event, wingetIds) => {
  return new Promise(resolve => {
    exec('winget list --accept-source-agreements 2>&1',
      { shell: true, timeout: 25000 },
      (_err, stdout) => {
        const out = (stdout || '').toLowerCase();
        const results = {};
        for (const id of wingetIds) results[id] = out.includes(id.toLowerCase());
        resolve(results);
      }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTO-UPDATE
// ═══════════════════════════════════════════════════════════════════════════════

// Сравнивает версии: '1.2.0' > '1.1.9' → true
function isNewerVersion(remote, current) {
  const r = remote.replace(/^v/, '').split('.').map(Number);
  const c = current.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (c[i] || 0)) return true;
    if ((r[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

// Скачивает файл по URL (следует редиректам)
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const dest = createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, { headers: { 'User-Agent': 'CompPack-Updater' } }, res => {
      // Следуем редиректу (GitHub Assets редиректят на S3)
      if (res.statusCode === 302 || res.statusCode === 301) {
        dest.close();
        downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      res.pipe(dest);
      dest.on('finish', () => dest.close(resolve));
      dest.on('error',  reject);
    }).on('error', reject);
  });
}

// Проверка новой версии на GitHub Releases
ipcMain.handle('check-update', async () => {
  return new Promise(resolve => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      headers: { 'User-Agent': 'CompPack-Updater' },
    };
    const req = https.get(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const remoteVersion = json.tag_name || '0.0.0';
          const hasUpdate = isNewerVersion(remoteVersion, CURRENT_VERSION);

          // Ищем .zip или .exe в assets релиза
          const assets = json.assets || [];
          const zipAsset = assets.find(a => a.name.endsWith('.zip'));
          const exeAsset = assets.find(a => a.name.endsWith('.exe'));
          const downloadUrl = (zipAsset || exeAsset)?.browser_download_url || null;

          resolve({ hasUpdate, remoteVersion, currentVersion: CURRENT_VERSION, downloadUrl, assetName: (zipAsset || exeAsset)?.name || null });
        } catch(e) {
          writeLog('Update check parse error: ' + e);
          resolve({ hasUpdate: false, error: e.message });
        }
      });
    });
    req.on('error', e => {
      writeLog('Update check network error: ' + e);
      resolve({ hasUpdate: false, error: e.message });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({ hasUpdate: false, error: 'timeout' }); });
  });
});

// Скачивание и применение обновления
ipcMain.on('apply-update', async (event, { downloadUrl, assetName }) => {
  const tmpDir  = app.getPath('temp');
  const zipPath = path.join(tmpDir, assetName || 'comppack_update.zip');
  const appDir  = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  const exePath = process.execPath;

  try {
    event.reply('update-progress', { step: 'download', pct: 60, msg: 'Скачал! Применяю...' });
    writeLog('Download complete: ' + zipPath);

    const assetExt = path.extname(assetName || '').toLowerCase();
    let newExe = null;

    if (assetExt === '.zip') {
      // Если архив — распаковываем
      const extractDir = path.join(tmpDir, 'comppack_update_extracted');
      await new Promise((res, rej) => {
        exec(
          `powershell -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${extractDir}'"`,
          { shell: true },
          (err) => err ? rej(err) : res()
        );
      });
      function findExe(dir) {
        for (const f of readdirSync(dir)) {
          const full = path.join(dir, f);
          if (statSync(full).isDirectory()) { const r = findExe(full); if (r) return r; }
          else if (f.endsWith('.exe')) return full;
        }
        return null;
      }
      newExe = findExe(extractDir);
    } else if (assetExt === '.exe') {
      // Если сам .exe — используем напрямую
      newExe = zipPath;
    }

    event.reply('update-progress', { step: 'extract', pct: 80, msg: 'Готово! Применяю...' });

if (newExe && app.isPackaged) {
      // Пишем .bat файл который: ждёт пока закроется старый .exe, копирует новый, запускает
      const batPath = path.join(tmpDir, 'comppack_update.bat');
      const batContent = [
        '@echo off',
        'timeout /t 3 /nobreak >nul',
        `copy /Y "${newExe}" "${exePath}"`,
        `start "" "${exePath}"`,
        'del "%~f0"',
      ].join('\r\n');

      require('fs').writeFileSync(batPath, batContent, 'utf8');

      const { spawn: sp } = require('child_process');
      sp('cmd.exe', ['/c', batPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();

      event.reply('update-progress', { step: 'done', pct: 100, msg: 'Готово! Перезапускаю...' });
      setTimeout(() => app.quit(), 1500);
    } else if (!app.isPackaged) {
      // В dev-режиме просто сообщаем об успехе
      event.reply('update-progress', { step: 'done', pct: 100, msg: 'Dev-режим: файлы в ' + extractDir });
    } else {
      event.reply('update-progress', { step: 'error', pct: 0, msg: 'Не нашёл .exe в архиве обновления' });
    }
  } catch(e) {
    writeLog('Update apply error: ' + e);
    event.reply('update-progress', { step: 'error', pct: 0, msg: 'Ошибка: ' + e.message });
  }
});

// ── Installation ──────────────────────────────────────────────────────────────
ipcMain.on('start-install', async (event, appsToInstall) => {
  writeLog(`=== Install session — ${appsToInstall.length} packages ===`);
  let errors = 0;

  for (let i = 0; i < appsToInstall.length; i++) {
    const item = appsToInstall[i];
    event.reply('app-status', { id: item.id, status: 'installing', index: i, total: appsToInstall.length });

    const { code } = await runItem(item);
    const ok = (code === 0);
    if (!ok) errors++;
    writeLog(`  ${ok ? 'OK' : 'ERROR'}: ${item.name} — exit ${code}`);

    event.reply('app-status', {
      id: item.id, status: ok ? 'done' : 'error',
      index: i, total: appsToInstall.length,
    });
  }

  writeLog(`=== Done — ${appsToInstall.length - errors} ok, ${errors} errors ===\n`);
  event.reply('install-complete', { errors });

  // Очищаем временные файлы локальных установщиков после установки
  if (app.isPackaged) {
    const unpackDir = path.join(process.resourcesPath, 'app.asar.unpacked', 'tools');
    try {
      if (existsSync(unpackDir)) {
        const files = readdirSync(unpackDir);
        for (const f of files) {
          const ext = path.extname(f).toLowerCase();
          if (['.exe', '.msi', '.bat', '.cmd'].includes(ext)) {
            try {
              rmSync(path.join(unpackDir, f), { force: true });
              writeLog(`  CLEANED: ${f}`);
            } catch {}
          }
        }
      }
    } catch(e) { writeLog('Cleanup error: ' + e); }
  }
});

// ── Resolve local tool path ───────────────────────────────────────────────────
function resolveLocalPath(filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : __dirname;
  return path.join(base, filePath);
}

function runItem(item) {
  return new Promise(resolve => {
    try {
      let proc;

      if (item.type === 'local') {
        const absPath = resolveLocalPath(item.localPath);
        const ext     = path.extname(absPath).toLowerCase();
        const args    = item.args ? item.args.split(' ') : [];

        writeLog('  PATH: ' + absPath);
        writeLog('  EXISTS: ' + existsSync(absPath));

        if (ext === '.bat' || ext === '.cmd') {
          proc = spawn('cmd', ['/c', '"' + absPath + '"', ...args], { shell: true, windowsHide: true });
        } else if (ext === '.msi') {
          proc = spawn('msiexec', ['/i', '"' + absPath + '"', '/passive', '/norestart', ...args],
            { shell: true, windowsHide: true });
        } else {
          proc = spawn('"' + absPath + '"', args, { shell: true, windowsHide: true });
        }
      } else {
        proc = spawn('winget', [
          'install', '--id', item.winget, '-e', '--silent',
          '--accept-source-agreements', '--accept-package-agreements',
        ], { shell: true, windowsHide: true });
      }

      proc.on('close', c  => resolve({ code: c ?? 0 }));
      proc.on('error', _e => resolve({ code: 999 }));
    } catch (e) {
      writeLog(`  SPAWN ERROR: ${item.name} — ${e}`);
      resolve({ code: 999 });
    }
  });
}
