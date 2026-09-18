const form = document.querySelector("#qr-form");
const input = document.querySelector("#url-input");
const message = document.querySelector("#form-message");
const qrCode = document.querySelector("#qr-code");
const downloadButton = document.querySelector("#download-button");

let currentUrl = "";
let renderedSize = 0;

function getQrSize() {
  const styles = getComputedStyle(qrCode);
  const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);

  return Math.floor(qrCode.clientWidth - horizontalPadding);
}

function renderQr() {
  const size = getQrSize();
  if (!currentUrl || size <= 0 || size === renderedSize) return;

  qrCode.replaceChildren();
  new QRCode(qrCode, {
    text: currentUrl,
    width: size,
    height: size,
    colorDark: "#17231f",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M,
  });
  renderedSize = size;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const url = input.value.trim();
  if (!url) return;

  currentUrl = url;
  renderedSize = 0;
  renderQr();
  message.textContent = "QR code ready.";
  downloadButton.disabled = false;
});

new ResizeObserver(() => {
  requestAnimationFrame(renderQr);
}).observe(qrCode);

downloadButton.addEventListener("click", () => {
  const canvas = qrCode.querySelector("canvas");
  if (!canvas || !currentUrl) return;

  const link = document.createElement("a");
  link.download = "qr-code.png";
  link.href = canvas.toDataURL("image/png");
  link.click();
});
