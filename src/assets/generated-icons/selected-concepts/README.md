# Selected ShellBeam logo concepts

The user retained concepts 01 (Beam Prompt) and 03 (Hex Channel) from the first
exploration board. On 2026-10-12, the user approved the dark-theme revision of
concept 03 as the official ShellBeam logo, replacing the previous V6 logo.

- `round-01-original.png`: unchanged source board, including retained concept 01
  in the first row/first column and concept 03 in the first row/third column.
- `concept-03-hex-channel.png`: standalone light-background concept 03.
- `concept-03-dark.png`: approved official logo, the dark-theme revision of 03.
- `previous-v6-app-icon.png`: unchanged previous application icon for comparison
  or an explicitly requested restoration.

The dark revision follows the existing workspace theme in `src/index.css`:
near-black navy `#070B10`, primary blue `#2563EB`, cool white `#F4F7FB`, and a
restrained sky/cyan beam. The original board and light variant are not replaced.
Artwork was isolated and recolored with the image-generation tool, so these
standalone PNGs are rendered derivatives rather than pixel-identical board crops.

The approved PNG is copied to `app-icon.png`. Run `npm run icons` from the app
root to regenerate application, favicon and native platform icon assets.
The iOS opaque background color in `scripts/generate-icons.mjs` follows the dark
tile. The application UI, favicon and native platform icon assets use this logo.
This adoption does not bump the version, create a commit, sign/notarize a build,
or publish a release. Previously published packages remain unchanged.
