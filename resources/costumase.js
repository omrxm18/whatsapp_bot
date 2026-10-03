const { texts } = require("./package.js");
const fs = require("fs");
const path = require("path");
const imagePath = path.join(__dirname, "../media/OMRX.jpg");
const img = fs.readFileSync(imagePath);
const contextInfo = {
  externalAdReply: {
    title: texts.botName,
    body: texts.dev,
    thumbnail: img,
    sourceUrl: "https://github.com/omrxm18.png",
    mediaUrl: "https://github.com/omrxm18.png",
    renderLargerThumbnail: false,
    showAdAttribution: false,
  },
};
module.exports = contextInfo;
