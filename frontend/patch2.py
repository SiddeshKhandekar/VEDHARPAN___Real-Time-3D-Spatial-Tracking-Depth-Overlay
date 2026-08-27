import os

with open("scene.js", "r", encoding="utf-8") as f:
    code = f.read()

# 1. Update New Game button
old_new = """        const btnNewGame = document.getElementById('btn-new-game');
        if (btnNewGame) {
            btnNewGame.addEventListener('click', () => {
                window.location.reload();
            });
        }"""
        
new_new = """        const btnNewGame = document.getElementById('btn-new-game');
        if (btnNewGame) {
            btnNewGame.addEventListener('click', () => {
                sessionStorage.setItem('vedharpan_autostart_newgame', 'true');
                window.location.reload();
            });
        }"""
if old_new in code:
    code = code.replace(old_new, new_new)
else:
    print("WARNING: Could not find old_new block")


# 2. Update btnStart text logic
old_start = """        // Main Menu Buttons
        const btnStart = document.getElementById('btn-start');
        if (btnStart) {
            btnStart.textContent = "Resume Game";
        }"""
        
new_start = """        // Main Menu Buttons
        const btnStart = document.getElementById('btn-start');
        if (btnStart) {
            if (sessionStorage.getItem('vedharpan_autostart_newgame')) {
                btnStart.textContent = "Start Game";
            } else {
                btnStart.textContent = "Resume Game";
            }
        }"""
if old_start in code:
    code = code.replace(old_start, new_start)
else:
    print("WARNING: Could not find old_start block")


# 3. Add auto-start execution at end of constructor
old_init = """        // 10. Start Rendering Loop
        this.animate();
    }"""
    
new_init = """        // 10. Start Rendering Loop
        this.animate();

        if (sessionStorage.getItem('vedharpan_autostart_newgame')) {
            sessionStorage.removeItem('vedharpan_autostart_newgame');
            // Allow renderer a split second to breathe before locking pointer
            setTimeout(() => {
                const startBtn = document.getElementById('btn-start');
                if (startBtn) startBtn.click();
            }, 250);
        }
    }"""
if old_init in code:
    code = code.replace(old_init, new_init)
else:
    print("WARNING: Could not find old_init block")


# 4. Remove the `isFirstStart` unused block from click inside old logic to change it cleanly?
# Actually, I'll just change btnStart.textContent to "Resume Game" on click
old_click = """        if (btnStart) {
            btnStart.addEventListener('click', () => {
                const isFirstStart = !document.getElementById('hud').classList.contains('hidden');"""

new_click = """        if (btnStart) {
            btnStart.addEventListener('click', () => {
                btnStart.textContent = "Resume Game";
                const isFirstStart = !document.getElementById('hud').classList.contains('hidden');"""
if old_click in code:
    code = code.replace(old_click, new_click)
else:
    print("WARNING: Could not find old_click block")

with open("scene.js", "w", encoding="utf-8") as f:
    f.write(code)

print("PATCH 2 APPLIED PERFECTLY")
