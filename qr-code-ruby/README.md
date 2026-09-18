# QR Code Generator

A small QR code generator that runs in the browser and can be published directly to GitHub Pages.

## Use it locally

Open `index.html` in a browser, enter a URL, and select **Generate**. The page uses the QR Code library from jsDelivr, so an internet connection is needed while the page loads.

The original Ruby version is still available:

```powershell
bundle install
ruby qr.rb
```

It writes the generated image to `sometest.png`.

## Publish with GitHub Pages

1. Push this repository to GitHub.
2. Open the repository's **Settings > Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the branch containing this version and the `/ (root)` folder, then select **Save**.

GitHub will provide the public URL after deployment. Since this is a static site, GitHub Pages serves `index.html` directly; it does not run `qr.rb`.
