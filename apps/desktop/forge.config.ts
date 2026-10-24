import { defineConfig } from '@electron/forge';
import { makerSquirrel } from '@electron/forge/maker-squirrel';
import { makerDeb } from '@electron/forge/maker-deb';
import { makerPat } from '@electron/forge/maker-pat';

export default defineConfig({
  packagerConfig: {
    name: 'Vanessa',
    executableName: 'Vanessa',
    productName: 'Vanessa',
    appCopyright: 'Copyright (c) 2026 Vanessa Labs',
    asar: true,
    extraResource: ["assets/vanessa-tray.png"],
    win32metadata: {
      CompanyName: 'Vanessa Labs',
      FileDescription: 'Vanessa - Voice-native AI control layer',
      OriginalFilename: 'Vanessa.exe',
      ProductName: 'Vanessa',
      InternalName: 'Vanessa',
    },
  },
  rebuildConfig: {},
  makers: [
    // Windows MSI generator via Squirrel
    makerSquirrel({
      name: 'Vanessa',
      setupExe: 'Vanessa-Setup-${version}.exe',
      setupIcon: 'assets/icon.ico',
      loadingGif: 'assets/loading.gif',
      noMsi: false,
      remoteReleases: 'https://github.com/Kshitij-Tripathi87/Project_Vanessa/releases',
    }),
    makerDeb(),
    makerPat(),
  ],
  plugins: [
    [
      '@electron/forge/plugin-auto-unpack-natives',
      {},
    ],
  ],
  publishers: [
    {
      name: '@electron/forge/publisher-github',
      config: {
        repository: {
          owner: 'Kshitij-Tripathi87',
          name: 'Project_Vanessa',
        },
        prerelease: false,
        draft: false,
      },
    },
  ],
};