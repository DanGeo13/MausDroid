# Releasing updates

Pushing to `main` runs `.github/workflows/release.yml`, which publishes to the
`updates` branch. Phones pick updates up within ~6 hours (or Settings →
Phone → Check now).

- Change only the engine/UI → bump `"engine"` in `version.json`. Phones
  update silently, no reinstall.
- Change the Android shell → bump `"apk"` too (and `"minApkForEngine"` if the
  new engine needs the new APK). Phones get a tap-to-install notification.

## One-time: add the signing secrets

GitHub → the repo → Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
|---|---|
| `MAUSDROID_UPDATE_KEY_PEM` | the whole text of `update-signing-key.pem` |
| `MAUSDROID_KEYSTORE_B64` | the text of `mausdroid-release.jks.base64.txt` |
| `MAUSDROID_KEYSTORE_PASSWORD` | the text of `keystore-password.txt` |

Keep the original files somewhere safe (password manager). If the APK key is
lost, phones can't install new APKs over the old one; if the update key is
lost, phones can't accept new engine updates.
