$files = @("js/app.js", "index.html")
$map = @{
    "ðŸŸ¢" = "\ud83d\udfe2"     # 🟢
    "âœ“" = "\u2713"           # ✓
    "â€¢" = "\u2022"           # •
    "â °" = "\u23f0"           # ⏰
    "â›”" = "\u26d4"           # ⛔
    "ðŸ“…" = "\ud83d\udcc5"     # 📅
    "â†’" = "\u2192"           # →
    "ðŸ§ª" = "\ud83e\uddea"     # 🧪
    "âœ…" = "\u2705"           # ✅
    "ðŸ•°" = "\u23f0"           # ⏰
    "ðŸ”«" = "\ud83d\udd2b"     # 🔫
    "ðŸ–¤" = "\ud83d\udda4"     # 🖤
    "ðŸ§" = "\ud83e\uddea"      # 🧪
    "ðŸ’»" = "\ud83d\udcbb"     # 💻
    "ðŸ“" = "\ud83d\udcc4"      # 📄
    "ðŸ“…" = "\ud83d\udcc5"      # 📅
    "â—" = "\u25cf"            # ●
    "â—‹" = "\u25cb"           # ○
}

foreach ($f in $files) {
    if (Test-Path $f) {
        # Read as Raw string (interpreting as UTF8)
        $content = [System.IO.File]::ReadAllText((Get-Item $f).FullName, [System.Text.Encoding]::UTF8)
        foreach ($key in $map.Keys) {
            $val = $map[$key]
            $content = $content.Replace($key, $val)
        }
        # Final safety: replace ANY non-ascii with its \u escape
         $fixed = [regex]::Replace($content, "[^\x00-\x7f]", {
            param($m) 
            $char = [int][char]$m.Value
            if ($char -gt 0xFFFF) {
                # This should not happen much if our map is good, but for safety:
                $high = [Math]::Floor(($char - 0x10000) / 0x400) + 0xD800
                $low = (($char - 0x10000) % 0x400) + 0xDC00
                String.Format("\u{0:x4}\u{1:x4}", [int]$high, [int]$low)
            } else {
                String.Format("\u{0:x4}", $char)
            }
        })
        [System.IO.File]::WriteAllText((Get-Item $f).FullName, $fixed, [System.Text.Encoding]::UTF8)
        Write-Host "Re-encoded: $f"
    }
}
