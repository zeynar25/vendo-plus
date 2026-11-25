# Vendo+ operator dashboard

The web page the operator uses to see which coffee hopper needs a refill first.
It follows the Figma file *Vendo+ Operator Dashboard* and reads everything through
`docs/api-contract.md`.

Plain HTML, CSS, and JavaScript: no framework, no build step, nothing to install.

## Run it

Open `frontend/index.html` in a browser. To serve it instead (closer to how the
backend will serve it):

```bash
cd frontend
python -m http.server 5173
# then open http://localhost:5173
```

## Files

| Path | What it holds |
| --- | --- |
| `index.html` | The page shell: header, navigation, and the script list |
| `css/tokens.css` | Colors and text styles copied from the Figma variables and text styles |
| `css/app.css` | Layout and shared components (pills, tags, buttons, cards) |
| `js/dom.js` | HTML escaping and the patch helper that updates the page without losing focus |
| `js/app.js` | Hash routes, navigation, and the 2-second refresh loop |
