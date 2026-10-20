# LunaTranslator ezTrans helper

`LunaSubprocess32.exe` is LunaTranslator's 32-bit helper process. The bridge starts it to reach ezTrans XP, whose
translation engine is a 32-bit Windows library (see `bridge/backends/eztrans.mjs`). It is used only on Windows and only for
the ezTrans translator. ezTrans XP itself is not included and must be installed separately.

| | |
|---|---|
| Project | [LunaTranslator](https://github.com/HIllya51/LunaTranslator) by HIllya51 |
| Version | v12.1.2.12, commit `51884b6c88cba8c42e98ce3e43c4f408017082a1` |
| Taken from | the release file `LunaTranslator_x64.zip`, path `LunaTranslator_x64/files/LunaSubprocess32.exe` |
| Changes | none: the file is copied unmodified |
| SHA-256 | `a9a204ced180495355096302007dd239e02bce0e2e038edf1a3258b0f47770d3` |
| License | GNU General Public License v3.0, in [LICENSE](LICENSE) |
| Source code | [github.com/HIllya51/LunaTranslator/tree/v12.1.2.12](https://github.com/HIllya51/LunaTranslator/tree/v12.1.2.12) |

`LICENSES/` holds the third-party license notices that LunaTranslator ships with that release.

This helper is a separate program that the bridge runs as its own process and talks to over a named pipe; the rest of
Subpair stays under its MIT license.

To update it: download a newer `LunaTranslator_x64.zip` from the project's releases, copy
`files/LunaSubprocess32.exe` and the `LICENSES/` folder here, and update the version, commit and SHA-256 above.
