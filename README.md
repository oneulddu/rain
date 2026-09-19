<div align="center">
 <img height="150" height="150" alt="Rain logo" src="src/assets/rain.png" />
</div>

<div align="center">
  <h1><b>rain</b></h1>
  <p><i>A custom Discord client for Mobile!<br>Designed to be lightweight and feature packed.</i></p>

  [![Discord](https://img.shields.io/discord/1368145952266911755?logo=discord&logoColor=%23ffffffff&color=%231D88CF&link=https%3A%2F%2Fdiscord.gg%2F6cN7wKa8gp)](https://discord.gg/6cN7wKa8gp)
  [![Static Badge](https://img.shields.io/badge/kofi-cocobo1-%23FF6433?style=flat&logo=ko-fi&labelColor=%23ffffff)](https://www.ko-fi.com/cocobo1)
  ![Codeberg Last Commit](https://img.shields.io/gitea/last-commit/raincord/rain?gitea_url=https%3A%2F%2Fwww.codeberg.org&logo=codeberg&logoColor=%23ffffffff)
</div>

## Install rain
> [!NOTE]
> rain is currently in beta. **Expect things to break and report bugs when you find them**

### Android

- **[rainManager](https://codeberg.org/raincord/rainManager/releases/latest)**

### iOS

- **[rainTweak](https://codeberg.org/raincord/RainTweak/releases/latest)**

## Custom builds

Build the regular bundle without startup diagnostic popups:

```sh
bun install --frozen-lockfile
bun run build --release-branch=main --build-bytecode
```

The output is `dist/rain.js` and `dist/rain.98.hbc` with the pinned Hermes compiler.
Use a direct download URL for the complete bundle in RainTweak's custom bundle setting.
Keep the bytecode version compatible with the installed Discord runtime.
On an ARM64 Linux build host, provide a compatible `hermesc` on `PATH`
(the bundled Linux compiler is x86-64) and verify that HBC generation succeeds.

Startup diagnostics are opt-in: add `--diagnostic` only when investigating a boot failure.
A diagnostic build displays a startup report; rebuild without that flag before publishing
normal bundles. Run the focused checks with:

```sh
node --test scripts/boot-diagnostics.test.mjs scripts/chattranslator-compat.test.mjs
```

## How can I support the project?

rain can be supported in many ways, you can [contribute](#contributing), make a [bug report](#bug-reporting) or [donate](https://www.ko-fi.com/cocobo1)!

## Bug-reporting

Bug reports are a crucial part of development, they make the project more stable and make developers aware of issues. Before filing an [issue](https://codeberg.org/raincord/rain/issues) please make sure it isnt a duplicate.

## Contributing

Discover how you can contribute at [contribution.md](contribution.md)!
