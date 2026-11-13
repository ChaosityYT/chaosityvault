# Chaosity Vault

Always-on shorts queue for the Chaosity Vault channel, on its own iHatePosting account (separate from Post Library).

- `windows/` - Electron tray app. Clips go in `Recordings\Edited\Chaosity Vault Uploads`; order and titles come from `Titles and Descriptions.csv` there. Posts to every active YouTube/TikTok account on the linked iHatePosting account. Build: `npm run build`.
- `ios/` - SwiftUI app: schedule (upcoming / published / failed), clip queue and PC controls through the hub. The IPA is built by GitHub Actions (Actions tab > Build iOS IPA > artifact `ChaosityVault-ipa`), unsigned, for sideloading.
- Hub: api.briangopaul.com, project `chaosityvault`. The iHatePosting key for this account is kept in the vault as `ihateposting_chaosityvault`.

No keys are stored in this repository.
