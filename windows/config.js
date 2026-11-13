// Everything that makes this app separate from the main Post Library: its own name, data folder, clip folder,
// iHatePosting sign-in, API key and hub project. Nothing here points at the main app's accounts or files.
const path = require("path");
const NAME = "Chaosity Vault";
module.exports = {
  NAME,
  APP_ID: "com.chaosity.chaosityvault",
  DATA: path.join(process.env.APPDATA, NAME),
  NC: "C:/Users/bgopa/OneDrive/Desktop/Recordings/Edited/Chaosity Vault Uploads", // the only clip source for this app
  PARTITION: "persist:ihateposting-chaosityvault",  // its own website sign-in (the second iHatePosting account)
  KIT: "C:/Users/bgopa/Documents/Funny Edit Kit",   // only for ffmpeg/ffprobe
  TZ: "America/Chicago",
};
