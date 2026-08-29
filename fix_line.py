with open('frontend/js/scene.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    if "ssets/porsche_911" in line:
        lines[i] = "            'assets/porsche_911_singer_twin_turbo.glb',\n"
        print("Replaced line", i)

with open('frontend/js/scene.js', 'w', encoding='utf-8') as f:
    f.writelines(lines)
print("FIX COMPLETELY EXECUTED")
