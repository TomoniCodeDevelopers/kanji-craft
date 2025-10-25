///% color=#3D7EFF weight=80 icon="\uf031" block="漢字クラフト"
namespace kanjiCraft {

    // ====== 設定 ======
    const TEXT_BLOCK = IRON_BLOCK         // 文字ブロック（必要なら変更）
    const BG_BLOCK = GRAY_CONCRETE     // 背景ブロック
    const HOLE_AS_AIR = true              // 四隅は AIR でくり抜く
    const HOLE_BLOCK = AIR                // HOLE_AS_AIR=false の場合に任意へ

    const REFILL_INTERVAL = 32            // エージェントの定期補充間隔（スロット1を定期補充）

    // レイアウト（プレビュー仕様に合わせる）
    const GAP = 1                         // 文字間セル
    const PAD = 2                         // 外周余白セル（背景のpad）

    // 互換維持用 enum（未使用）
    export enum Plane {
        //% block="床"
        Floor = 0,
        //% block="壁"
        Wall = 1
    }

    // ---- 補助 ----
    function idiv(a: number, b: number) { return (a / b) >> 0 } // Math.idiv 代替
    function slice_(s: string, start: number, endExclusive: number): string {
        if (start < 0) start = 0
        if (endExclusive > s.length) endExclusive = s.length
        let r = ""
        for (let i = start; i < endExclusive; i++) r += s.charAt(i)
        return r
    }
    function isHexString(s: string): boolean {
        if (s.length === 0) return false
        for (let i = 0; i < s.length; i++) {
            const c = s.charAt(i)
            const ok = (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F")
            if (!ok) return false
        }
        return true
    }
    function isDigits(s: string): boolean {
        if (s.length === 0) return false
        for (let i = 0; i < s.length; i++) {
            const c = s.charAt(i)
            if (!(c >= "0" && c <= "9")) return false
        }
        return true
    }

    // ---- "WxH:HEX..." → ビット配列 ----
    function parseHeader(code: string): { w: number, h: number, bits: number[][] } {
        if (!code || code.length < 5) { player.say("コードが空です"); return null }

        let idxX = code.indexOf("x"); if (idxX < 0) idxX = code.indexOf("X")
        const idxColon = code.indexOf(":")
        if (idxX <= 0 || idxColon < 0 || idxColon <= idxX + 1) {
            player.say("形式は 16x16:12345... のようにしてください"); return null
        }

        const wStr = slice_(code, 0, idxX)
        const hStr = slice_(code, idxX + 1, idxColon)
        if (!isDigits(wStr) || !isDigits(hStr)) { player.say("サイズが数字ではありません"); return null }
        const w = parseInt(wStr), h = parseInt(hStr)
        if (w <= 0 || h <= 0 || w > 64 || h > 64) { player.say("サイズは1〜64にしてください"); return null }

        const need = idiv(w * h + 3, 4)         // 必要HEX桁
        const hexStart = idxColon + 1
        const hexEnd = hexStart + need
        if (hexEnd > code.length) { player.say("桁数不足（必要 " + need + " 桁）"); return null }
        const hex = slice_(code, hexStart, hexEnd)
        if (!isHexString(hex)) { player.say("16進以外の文字が混在しています"); return null }

        const bits: number[][] = []
        for (let y = 0; y < h; y++) {
            const row: number[] = []
            for (let x = 0; x < w; x++) row.push(0)
            bits.push(row)
        }

        let bitIndex = 0
        const totalBits = w * h
        for (let i = 0; i < hex.length && bitIndex < totalBits; i++) {
            const v = parseInt(hex.charAt(i), 16)
            for (let k = 3; k >= 0 && bitIndex < totalBits; k--) {
                const b = (v >> k) & 1
                const y = idiv(bitIndex, w)
                const x = bitIndex % w
                bits[y][x] = b
                bitIndex++
            }
        }
        return { w, h, bits }
    }

    // ---- 連結 "16x16:HEX64" を左から抽出 ----
    function parseMany16(codes: string): { w: number, h: number, bits: number[][] }[] {
        const out: { w: number, h: number, bits: number[][] }[] = []
        if (!codes) return out
        const needle = "16x16:"
        const needHex = 64
        const n = codes.length
        let i = 0
        while (true) {
            const idx = codes.indexOf(needle, i)
            if (idx < 0) break
            let k = idx + needle.length
            let hex = ""
            let aborted = false
            while (k < n && hex.length < needHex) {
                const c = codes.charAt(k)
                if ((c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F")) { hex += c; k++ }
                else { aborted = true; k++; break }
            }
            if (!aborted && hex.length === needHex) {
                const bmp = parseHeader(needle + hex)
                if (bmp) out.push(bmp)
                i = k
            } else {
                if (k >= n) break
                i = k
            }
        }
        return out
    }

    // ---- 位置（壁面固定 / 原点=左上表示）----
    function posAtWall(origin: Position, x: number, yImg: number): Position {
        // 画像の +Y（下方向）をワールドの -Y に変換（「下へ進む＝Yを減らす」）
        return positions.add(origin, positions.create(x, -yImg, 0))
    }

    // 背景の四隅穴セル（各文字ごと）
    function holeCellsForChar(bgWidth: number, bgHeight: number): number[][] {
        return [
            [1, 1],
            [bgWidth - 2, 1],
            [1, bgHeight - 2],
            [bgWidth - 2, bgHeight - 2]
        ]
    }

    // エージェント補充
    function ensureAgentStockIfNeeded(counter: number) {
        if (counter % REFILL_INTERVAL === 0) {
            agent.setItem(TEXT_BLOCK, 64, 1)
            agent.setSlot(1)
        }
    }

    // ---- メイン：壁面固定 / Yマイナス方向へ並べる ----
    //% blockId=kc_write_agent_here
    //% block="エージェントに 文字 %code を 壁 に 今いる場所から書いてもらう"
    //% weight=90 blockNamespace="kanjiCraft"
    export function agentWriteHere(code: string) {
        const origin = agent.getPosition()
        if (!origin) { player.say("エージェントの位置が取得できません"); return }

        const many = parseMany16(code)
        if (many.length === 0) {
            const bmp0 = parseHeader(code)
            if (!bmp0) return
            many.push(bmp0)
        }

        // 定数
        const w = 16, h = 16
        const bgW = w + PAD * 2      // =20
        const bgH = h + PAD * 2      // =20
        const gap = GAP              // =1
        const leftX = -PAD           // 全体左端（画像座標）
        const topY = -PAD           // 全体上端（画像座標）
        const totalW = bgW           // 横は常に1文字分の背景幅
        const totalH = many.length * h + (many.length - 1) * gap + PAD * 2

        // 初期在庫
        agent.setItem(TEXT_BLOCK, 64, 1)
        agent.setSlot(1)

        // === 1) 背景 fill（各文字の 20×20 を壁面 z=0 に敷く） ===
        let offsetY = 0
        const offsetX = 0
        for (let gi = 0; gi < many.length; gi++) {
            const from = posAtWall(origin, leftX, topY + offsetY)
            const to = posAtWall(origin, leftX + bgW - 1, topY + offsetY + bgH - 1)
            blocks.fill(BG_BLOCK, from, to, FillOperation.Replace)
            offsetY += h + gap
        }

        // === 2) 全体の四隅のみ AIR で穴開け（壁面 z=0） ===
        const tl = posAtWall(origin, leftX + 1, topY + 1)
        const tr = posAtWall(origin, leftX + totalW - 2, topY + 1)
        const bl = posAtWall(origin, leftX + 1, topY + totalH - 2)
        const br = posAtWall(origin, leftX + totalW - 2, topY + totalH - 2)
        blocks.place(AIR, tl)
        blocks.place(AIR, tr)
        blocks.place(AIR, bl)
        blocks.place(AIR, br)

        // === 3) 背景の1マス手前（z=+1）を 全域 AIR で一括クリア ===
        // ここまでで totalW, totalH, leftX, topY は算出済み（前の処理と同じ値）
        {
            // 壁面 z=0 上の全体矩形の対応座標
            const fromWall = posAtWall(origin, leftX, topY)
            const toWall = posAtWall(origin, leftX + totalW - 1, topY + totalH - 1)

            // z=+1 側（背景の1マス手前）へシフトして、その範囲を一括で AIR に置換
            const fromFront = positions.add(fromWall, positions.create(0, 0, +1))
            const toFront = positions.add(toWall, positions.create(0, 0, +1))
            blocks.fill(AIR, fromFront, toFront, FillOperation.Replace)
        }

        // === 4) 文字をエージェントで配置（z=+1 側へ） ===
        let placed = 0
        offsetY = 0
        for (let gi = 0; gi < many.length; gi++) {
            const bmp = many[gi]
            for (let y = 0; y < 16; y++) {
                for (let x = 0; x < 16; x++) {
                    if (!bmp.bits[y][x]) continue

                    const targetWall = posAtWall(origin, 0 + x, offsetY + y)              // z=0
                    const targetFront = positions.add(targetWall, positions.create(0, 0, +1)) // z=+1（ここに置く）

                    // エージェントは targetFront の 1 マス先（z=+2）に立ち、北向きで FORWARD（-Z）に配置 ⇒ z=+1 に置かれる
                    const stand = positions.add(targetFront, positions.create(0, 0, +1)) // z=+2
                    agent.teleport(stand, NORTH)
                    ensureAgentStockIfNeeded(placed)
                    agent.place(FORWARD) // -Z へ1マス置く → z=+1
                    placed++
                }
            }
            offsetY += 16 + GAP
        }
    }
}
