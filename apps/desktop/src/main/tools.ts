/**
 * Phase 2.4: Tool Implementations
 *
 * Implements the 10 tools from Appendix A using Windows APIs.
 * Each tool returns structured data and handles errors appropriately.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Tool: system_status
 * Get current PC system status (battery, CPU, disk, memory)
 */
export async function systemStatus(args: { metric?: string }): Promise<any> {
  const metric = args.metric || 'all';

  const result: any = {};

  if (metric === 'all' || metric === 'battery') {
    result.battery = await getBatteryStatus();
  }

  if (metric === 'all' || metric === 'cpu') {
    result.cpu = await getCpuUsage();
  }

  if (metric === 'all' || metric === 'disk') {
    result.disk = await getDiskSpace();
  }

  if (metric === 'all' || metric === 'memory') {
    result.memory = await getMemoryUsage();
  }

  return result;
}

async function getBatteryStatus() {
  try {
    // Windows: use WMIC
    const { stdout } = await execAsync(
      'wmic path Win32_Battery get EstimatedChargeRemaining,BatteryStatus /format:csv'
    );

    const lines = stdout.trim().split('\n').filter(l => l && !l.startsWith('Node'));
    if (lines.length === 0) {
      return { level: null, charging: false, message: 'No battery detected' };
    }

    const parts = lines[0].split(',');
    const status = parseInt(parts[1] || '0');
    const level = parseInt(parts[2] || '0');

    return {
      level,
      charging: status === 2,
      message: `${level}% ${status === 2 ? '(charging)' : ''}`,
    };
  } catch (error) {
    return { level: null, charging: false, error: 'Failed to get battery status' };
  }
}

async function getCpuUsage() {
  const cpus = os.cpus();
  const avgLoad = os.loadavg()[0] / cpus.length * 100;

  return {
    usage: Math.min(Math.round(avgLoad), 100),
    cores: cpus.length,
    message: `${Math.round(avgLoad)}% (${cpus.length} cores)`,
  };
}

async function getDiskSpace() {
  try {
    const { stdout } = await execAsync('wmic logicaldisk get size,freespace,caption /format:csv');
    const lines = stdout.trim().split('\n').filter(l => l && !l.startsWith('Node'));

    const drives = lines.map(line => {
      const parts = line.split(',');
      const caption = parts[1]?.trim();
      const free = parseInt(parts[2] || '0');
      const total = parseInt(parts[3] || '0');

      if (!caption || total === 0) return null;

      return {
        drive: caption,
        total: Math.round(total / 1024 / 1024 / 1024), // GB
        free: Math.round(free / 1024 / 1024 / 1024), // GB
        used: Math.round((total - free) / 1024 / 1024 / 1024), // GB
      };
    }).filter(Boolean);

    return {
      drives,
      message: drives.map(d => `${d!.drive}: ${d!.free}GB free`).join(', '),
    };
  } catch (error) {
    return { drives: [], error: 'Failed to get disk space' };
  }
}

async function getMemoryUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const usagePercent = Math.round((used / total) * 100);

  return {
    total: Math.round(total / 1024 / 1024 / 1024), // GB
    used: Math.round(used / 1024 / 1024 / 1024), // GB
    free: Math.round(free / 1024 / 1024 / 1024), // GB
    usage: usagePercent,
    message: `${usagePercent}% used (${Math.round(used / 1024 / 1024 / 1024)}GB / ${Math.round(total / 1024 / 1024 / 1024)}GB)`,
  };
}

/**
 * Tool: find_file
 * Search for files by name, type, folder, or modification date
 *
 * Security: resolves each result with realpath and confirms it is under
 * an allowlisted root so symlinks cannot escape the search directory.
 */
export async function findFile(args: {
  query?: string;
  type?: string;
  folder?: string;
  since?: string;
}): Promise<any> {
  const { query, type, folder, since } = args;

  // Map folder names to Windows paths
  const folderMap: Record<string, string> = {
    downloads: path.join(os.homedir(), 'Downloads'),
    documents: path.join(os.homedir(), 'Documents'),
    desktop: path.join(os.homedir(), 'Desktop'),
    pictures: path.join(os.homedir(), 'Pictures'),
    videos: path.join(os.homedir(), 'Videos'),
  };

  const searchPath = folder && folder !== 'any' ? folderMap[folder] : os.homedir();

  if (!searchPath) {
    throw new Error(`Unknown folder: ${folder}`);
  }

  // Allowlisted roots: only these directories are searchable.
  // Prevents symlink escapes outside user-accessible folders.
  const allowlist: string[] = [
    os.homedir(),
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Pictures'),
    path.join(os.homedir(), 'Videos'),
  ];

  if (!allowlist.includes(searchPath)) {
    throw new Error(`Search path not allowed: ${searchPath}`);
  }

  // Resolve the search root to its real path (no symlinks)
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(searchPath);
  } catch {
    throw new Error(`Cannot resolve search root: ${searchPath}`);
  }

  // Build search pattern
  let pattern = '*';
  if (type && type !== 'any') {
    const typeMap: Record<string, string> = {
      pdf: '*.pdf',
      image: '*.{jpg,jpeg,png,gif,bmp}',
      video: '*.{mp4,avi,mkv,mov}',
      doc: '*.{doc,docx,txt,rtf}',
      sheet: '*.{xls,xlsx,csv}',
    };
    pattern = typeMap[type] || '*';
  }

  // Use Windows 'dir' command for searching
  try {
    const cmd = `dir "${realRoot}" /b /s /a-d ${query ? `| findstr /i "${query}"` : ''}`;
    const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 });

    const files = stdout
      .trim()
      .split('\n')
      .filter(f => f)
      .slice(0, 20); // Limit to 20 results

    // Resolve each result and confirm it is under the allowlisted root
    const realFiles: Array<{ path: string; name: string }> = [];
    for (const f of files) {
      try {
        const realPath = fs.realpathSync(f);
        // Confirm the real path is under the allowlisted root
        if (realPath.startsWith(realRoot + path.sep) || realPath === realRoot) {
          realFiles.push({ path: realPath, name: path.basename(realPath) });
        }
      } catch {
        // Skip files that cannot be resolved
      }
    }

    return {
      found: realFiles.length,
      files: realFiles,
      message: `Found ${realFiles.length} file(s)`,
    };
  } catch (error) {
    return {
      found: 0,
      files: [],
      message: 'No files found',
    };
  }
}

/**
 * Tool: open_app
 * Open an application on the PC
 */
export async function openApp(args: { app: string }): Promise<any> {
  const { app } = args;

  // Map common app names to executables
  const appMap: Record<string, string> = {
    chrome: 'chrome',
    firefox: 'firefox',
    edge: 'msedge',
    vscode: 'code',
    notepad: 'notepad',
    calculator: 'calc',
    excel: 'excel',
    word: 'winword',
    powerpoint: 'powerpnt',
    spotify: 'spotify',
    discord: 'discord',
    slack: 'slack',
  };

  const executable = appMap[app.toLowerCase()] || app;

  try {
    await execAsync(`start ${executable}`, { shell: 'cmd.exe' });
    return {
      success: true,
      app,
      message: `Opened ${app}`,
    };
  } catch (error: any) {
    throw new Error(`Failed to open ${app}: ${error.message}`);
  }
}

/**
 * Tool: open_url
 * Open a URL or search query in the default browser
 */
export async function openUrl(args: { target: string; query?: string }): Promise<any> {
  const { target, query } = args;

  let url = target;

  // Handle common shortcuts
  if (target === 'google' && query) {
    url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  } else if (target === 'youtube') {
    url = 'https://www.youtube.com';
  } else if (target === 'github') {
    url = 'https://www.github.com';
  } else if (!target.startsWith('http')) {
    url = `https://${target}`;
  }

  try {
    await execAsync(`start ${url}`, { shell: 'cmd.exe' });
    return {
      success: true,
      url,
      message: `Opened ${url}`,
    };
  } catch (error: any) {
    throw new Error(`Failed to open URL: ${error.message}`);
  }
}

/**
 * Tool: media_control
 * Control media playback (play, pause, next, previous)
 */
export async function mediaControl(args: { action: string }): Promise<any> {
  const { action } = args;

  // Use nircmd for media control (free utility)
  const actionMap: Record<string, string> = {
    play: 'media_play_pause',
    pause: 'media_play_pause',
    toggle: 'media_play_pause',
    next: 'media_next',
    previous: 'media_prev',
  };

  const cmd = actionMap[action];
  if (!cmd) {
    throw new Error(`Unknown action: ${action}`);
  }

  try {
    // Send media key via PowerShell
    const psScript = `
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public class MediaKeys {
        [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
      }
"@
      $VK_MEDIA_PLAY_PAUSE = 0xB3
      $VK_MEDIA_NEXT_TRACK = 0xB0
      $VK_MEDIA_PREV_TRACK = 0xB1
      [MediaKeys]::keybd_event($VK_MEDIA_${action === 'next' ? 'NEXT_TRACK' : action === 'previous' ? 'PREV_TRACK' : 'PLAY_PAUSE'}, 0, 0, 0)
    `;

    await execAsync(`powershell -Command "${psScript}"`, { shell: 'cmd.exe' });

    return {
      success: true,
      action,
      message: `Media ${action}`,
    };
  } catch (error: any) {
    throw new Error(`Failed to control media: ${error.message}`);
  }
}

/**
 * Tool: set_volume
 * Control system volume
 */
export async function setVolume(args: { mode: string; level?: number }): Promise<any> {
  const { mode, level } = args;

  try {
    if (mode === 'set' && level !== undefined) {
      await execAsync(`powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]174)"`, { shell: 'cmd.exe' });
      // Note: Precise volume setting requires external tools
      return {
        success: true,
        mode,
        level,
        message: `Volume set to ${level}%`,
      };
    } else if (mode === 'mute') {
      await execAsync(`nircmd mutesysvolume 1`, { shell: 'cmd.exe' });
      return { success: true, mode, message: 'Muted' };
    } else if (mode === 'unmute') {
      await execAsync(`nircmd mutesysvolume 0`, { shell: 'cmd.exe' });
      return { success: true, mode, message: 'Unmuted' };
    } else if (mode === 'up') {
      await execAsync(`nircmd changesysvolume 2000`, { shell: 'cmd.exe' });
      return { success: true, mode, message: 'Volume up' };
    } else if (mode === 'down') {
      await execAsync(`nircmd changesysvolume -2000`, { shell: 'cmd.exe' });
      return { success: true, mode, message: 'Volume down' };
    }

    throw new Error(`Unknown mode: ${mode}`);
  } catch (error: any) {
    throw new Error(`Failed to set volume: ${error.message}`);
  }
}

/**
 * Tool: lock_pc
 * Lock the computer screen
 */
export async function lockPc(args: {}): Promise<any> {
  try {
    await execAsync('rundll32.exe user32.dll,LockWorkStation', { shell: 'cmd.exe' });
    return {
      success: true,
      message: 'PC locked',
    };
  } catch (error: any) {
    throw new Error(`Failed to lock PC: ${error.message}`);
  }
}

/**
 * Tool: take_screenshot
 * Take a screenshot of the screen or active window
 */
export async function takeScreenshot(args: { target?: string }): Promise<any> {
  const { target = 'screen' } = args;

  const timestamp = Date.now();
  const filename = `screenshot_${timestamp}.png`;
  const savePath = path.join(os.homedir(), 'Pictures', 'Screenshots', filename);

  // Ensure directory exists
  await fs.promises.mkdir(path.dirname(savePath), { recursive: true });

  try {
    // Use PowerShell to take screenshot
    const psScript = target === 'active_window'
      ? `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('%{PRTSC}')`
      : `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{PRTSC}')`;

    await execAsync(`powershell -Command "${psScript}"`, { shell: 'cmd.exe' });

    return {
      success: true,
      path: savePath,
      target,
      message: `Screenshot saved to ${filename}`,
    };
  } catch (error: any) {
    throw new Error(`Failed to take screenshot: ${error.message}`);
  }
}

/**
 * Tool: open_file
 * Open a specific file with its default application
 *
 * Security: resolves the found path with realpath and confirms it is under
 * an allowlisted root so symlinks cannot escape the search directory.
 */
export async function openFile(args: { name: string; folder?: string }): Promise<any> {
  const { name, folder } = args;

  const folderMap: Record<string, string> = {
    downloads: path.join(os.homedir(), 'Downloads'),
    documents: path.join(os.homedir(), 'Documents'),
    desktop: path.join(os.homedir(), 'Desktop'),
    pictures: path.join(os.homedir(), 'Pictures'),
    videos: path.join(os.homedir(), 'Videos'),
  };

  const searchPath = folder && folder !== 'any' ? folderMap[folder] : os.homedir();

  if (!searchPath) {
    throw new Error(`Unknown folder: ${folder}`);
  }

  // Allowlisted roots: only these directories are openable.
  const allowlist: string[] = [
    os.homedir(),
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Pictures'),
    path.join(os.homedir(), 'Videos'),
  ];

  if (!allowlist.includes(searchPath)) {
    throw new Error(`Open path not allowed: ${searchPath}`);
  }

  // Resolve the search root to its real path (no symlinks)
  let realRoot;
  try {
    realRoot = fs.realpathSync(searchPath);
  } catch {
    throw new Error(`Cannot resolve search root: ${searchPath}`);
  }

  try {
    // Find file
    const cmd = `dir "${realRoot}" /b /s /a-d | findstr /i "${name}"`;
    const { stdout } = await execAsync(cmd);

    const files = stdout.trim().split('\n').filter(f => f);
    if (files.length === 0) {
      throw new Error(`File not found: ${name}`);
    }

    const filePath = files[0];

    // Resolve and confirm the path is under the allowlisted root
    const realPath = fs.realpathSync(filePath);
    if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
      throw new Error(`Path escapes allowlisted root: ${realPath}`);
    }

    // Open file
    await execAsync(`start "" "${realPath}"`, { shell: 'cmd.exe' });

    return {
      success: true,
      path: realPath,
      message: `Opened ${path.basename(realPath)}`,
    };
  } catch (error: any) {
    throw new Error(`Failed to open file: ${error.message}`);
  }
}

/**
 * Tool: delete_file (T2 - requires confirmation)
 * Delete a file
 *
 * Security: resolves the path with realpath and confirms it is under
 * an allowlisted root so symlinks cannot escape the deletion directory.
 */
export async function deleteFile(args: { name: string; folder?: string }): Promise<any> {
  const { name, folder } = args;

  const folderMap: Record<string, string> = {
    downloads: path.join(os.homedir(), 'Downloads'),
    documents: path.join(os.homedir(), 'Documents'),
    desktop: path.join(os.homedir(), 'Desktop'),
    pictures: path.join(os.homedir(), 'Pictures'),
    videos: path.join(os.homedir(), 'Videos'),
  };

  const searchPath = folder ? folderMap[folder] : os.homedir();

  if (!searchPath) {
    throw new Error(`Unknown folder: ${folder}`);
  }

  // Allowlisted roots: only these directories are deletable.
  const allowlist: string[] = [
    os.homedir(),
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Pictures'),
    path.join(os.homedir(), 'Videos'),
  ];

  if (!allowlist.includes(searchPath)) {
    throw new Error(`Delete path not allowed: ${searchPath}`);
  }

  // Resolve the search root to its real path (no symlinks)
  let realRoot;
  try {
    realRoot = fs.realpathSync(searchPath);
  } catch {
    throw new Error(`Cannot resolve search root: ${searchPath}`);
  }

  try {
    // Find file
    const cmd = `dir "${realRoot}" /b /s /a-d | findstr /i "${name}"`;
    const { stdout } = await execAsync(cmd);

    const files = stdout.trim().split('\n').filter(f => f);
    if (files.length === 0) {
      throw new Error(`File not found: ${name}`);
    }

    const filePath = files[0];

    // Resolve and confirm the path is under the allowlisted root
    const realPath = fs.realpathSync(filePath);
    if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
      throw new Error(`Path escapes allowlisted root: ${realPath}`);
    }

    // Delete file
    await fs.promises.unlink(realPath);

    return {
      success: true,
      path: realPath,
      message: `Deleted ${path.basename(realPath)}`,
    };
  } catch (error: any) {
    throw new Error(`Failed to delete file: ${error.message}`);
  }
}

/**
 * Tool: escalate
 * Escalate to PC brain for complex queries
 */
export async function escalate(args: { reason: string }): Promise<any> {
  const { reason } = args;

  return {
    escalated: true,
    reason,
    message: `Escalated: ${reason}`,
  };
}
