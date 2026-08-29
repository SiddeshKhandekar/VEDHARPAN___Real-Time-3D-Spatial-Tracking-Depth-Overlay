import re
with open("frontend/js/scene.js", "r", encoding="utf-8") as f:
    code = f.read()
code = code.replace(" ssets/porsche_911_singer_twin_turbo.glb,", " 'assets/porsche_911_singer_twin_turbo.glb',")
with open("frontend/js/scene.js", "w", encoding="utf-8") as f:
    f.write(code)
print("FIXED QUOTES!")
