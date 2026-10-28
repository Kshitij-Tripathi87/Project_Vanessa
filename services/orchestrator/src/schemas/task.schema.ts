export const TASK_SCHEMAS: Record<string, { description: string; requiredParams: string[] }> = {
  "wifi.restart_adapter": {
    description: "Restarts the local Wi-Fi network interface card.",
    requiredParams: [],
  },
  "brightness.list": {
    description: "Lists displays with observed brightness capability.",
    requiredParams: [],
  },
  "brightness.get": {
    description: "Reads observed brightness for a selected display.",
    requiredParams: [],
  },
  "brightness.set": {
    description: "Sets display brightness percentage and verifies read-back.",
    requiredParams: ["brightnessPercent"],
  },
  "bluetooth.list": {
    description: "Lists discovered Bluetooth radios and observed states.",
    requiredParams: [],
  },
  "bluetooth.status": {
    description: "Reads observed Bluetooth radio state.",
    requiredParams: [],
  },
  "bluetooth.set": {
    description: "Sets explicit Bluetooth radio state and verifies read-back.",
    requiredParams: ["state"],
  },
  "bluetooth.enable": {
    description: "Enables Bluetooth radio adapter.",
    requiredParams: [],
  },
  "bluetooth.disable": {
    description: "Disables Bluetooth radio adapter.",
    requiredParams: [],
  },
  "volume.set": {
    description: "Sets system master audio volume percentage (0-100).",
    requiredParams: ["level"],
  },
  "volume.get": {
    description: "Reads actual playback volume and mute state.",
    requiredParams: [],
  },
  "volume.mute": {
    description: "Sets playback mute explicitly and verifies read-back.",
    requiredParams: ["muted"],
  },
  "app.open": {
    description: "Opens an application by executable name or path.",
    requiredParams: ["name"],
  },
  "browser.open_url": {
    description: "Opens a URL in default web browser.",
    requiredParams: ["url"],
  },
  "youtube.search_and_play": {
    description: "Searches YouTube and initiates video playback.",
    requiredParams: ["query"],
  },
  "folder.create": {
    description: "Creates a directory folder in the designated path.",
    requiredParams: ["name"],
  },
  "claude_code.open": {
    description: "Spawns Claude Code CLI inside a dedicated terminal with an initial prompt.",
    requiredParams: ["prompt"],
  },
  "drive.upload": {
    description: "Uploads designated file or project to Google Drive and generates a shareable link.",
    requiredParams: ["file"],
  },
  "gmail.send": {
    description: "Transmits email to recipient with subject and body.",
    requiredParams: ["to", "subject"],
  },
};
