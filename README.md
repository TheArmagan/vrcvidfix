# VRCVidFix

VRCVidFix fixes most **"video failed to load"** issues in VRChat by replacing VRChat's `yt-dlp.exe` with a safe proxy.

## Download

- Direct download: https://github.com/TheArmagan/vrcvidfix/releases/download/v0.1.0/vrcvidfix.exe


## How it works (simple)

- VRChat calls `yt-dlp.exe` (actually VRCVidFix).
- VRCVidFix asks a local background service to prepare the stream.
- The service resolves URL + runs ffmpeg + serves HLS locally.

Result: stable playback and fewer random load failures.

## Super simple install

1. Download `vrcvidfix.exe`.
2. Double-click it.
3. Select `Install`.
4. Accept admin prompts (Task Scheduler + hosts entry).
5. Done.

On first run, dependencies are downloaded automatically:

- `yt-dlp-original.exe`
- `ffmpeg.exe`
- `bun.exe`

They are stored in:

`C:\Users\<you>\.vrcvidfix`

## Update

- Double-click the new `vrcvidfix.exe`.
- Choose `Update`.

## Uninstall

- Double-click `vrcvidfix.exe`.
- Choose `Uninstall / Remove`.

## Notes

- Logs are written to:

`C:\Users\<you>\.vrcvidfix\vrcvidfix-debug.log`

## Support

- Discord support server: https://discord.gg/spfmB7S78n

## Credits

Created by Armagan  
GitHub: https://github.com/TheArmagan/vrcvidfix
