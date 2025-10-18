///% color=#3D7EFF weight=80 icon="\uf031" block="漢字クラフト"
namespace kanjiCraft {

    const TEXT_BLOCK = IRON_BLOCK      // 文字ブロック（必要なら変更）

    // 既定の安全動作
    const PLACE_ONLY_AIR = true        // 既存ブロックを上書きしない（空気のみ配置）
    const REFILL_INTERVAL = 32         // エージェントの定期補充間隔（スロット1を定期補充）

    export enum Plane {
        //% block="床"
        Floor = 0,
        //% block="壁"
        Wall = 1
    }

    // ---- 文字列ユーティリティ（TSサブセット対応）----
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

    // ---- "WxH:HEX..." → ビット配列（16進は必要桁数のみ検証）----
    function parseHeader(code: string): { w: number, h: number, bits: number[][] } {
        if (!code || code.length < 5) { player.say("コードが空です"); return null }

        let idxX = code.indexOf("x"); if (idxX < 0) idxX = code.indexOf("X")
        const idxColon = code.indexOf(":")
        if (idxX <= 0 || idxColon < 0 || idxColon <= idxX + 1) {
            player.say("形式は 16x16:12345... のようにしてください")
            return null
        }

        const wStr = slice_(code, 0, idxX)
        const hStr = slice_(code, idxX + 1, idxColon)
        if (!isDigits(wStr) || !isDigits(hStr)) { player.say("サイズが数字ではありません"); return null }
        const w = parseInt(wStr), h = parseInt(hStr)
        if (w <= 0 || h <= 0 || w > 64 || h > 64) { player.say("サイズは1〜64にしてください"); return null }

        const need = Math.idiv(w * h + 3, 4)               // 必要なHEX桁数のみ取得
        const hexStart = idxColon + 1
        const hexEnd = hexStart + need
        if (hexEnd > code.length) { player.say("桁数不足しています（必要 " + need + " 桁）"); return null }
        const hex = slice_(code, hexStart, hexEnd)
        if (!isHexString(hex)) { player.say("16進以外の文字が混在しています"); return null }

        const totalBits = w * h
        const bits: number[][] = []
        for (let y = 0; y < h; y++) {
            const row: number[] = []
            for (let x = 0; x < w; x++) row.push(0)
            bits.push(row)
        }

        let bitIndex = 0
        for (let i = 0; i < hex.length && bitIndex < totalBits; i++) {
            const v = parseInt(hex.charAt(i), 16)
            for (let k = 3; k >= 0 && bitIndex < totalBits; k--) {
                const b = (v >> k) & 1
                const y = Math.idiv(bitIndex, w)
                const x = bitIndex % w
                bits[y][x] = b
                bitIndex++
            }
        }
        return { w, h, bits }
    }

    // ---- 位置ヘルパ（原点=左上に見える配置）----
    function posAtWall(origin: Position, x: number, y: number): Position {
        // 壁：画像yは下へ+, MinecraftのYは上へ+ なので -y で写像（上下反転を打ち消す）
        return positions.add(origin, positions.create(x, -y, 0))
    }
    function posAtFloor(origin: Position, x: number, z: number): Position {
        // 床：画像yの下方向をワールド+Z（南）に対応（世界座標で安定）
        return positions.add(origin, positions.create(x, 0, z))
    }

    // ---- 安全補助 ----
    function isAir(pos: Position): boolean {
        return blocks.testForBlock(AIR, pos)
    }
    // getItemCount に依存しない定期補充（スロット1固定）
    function ensureAgentStockIfNeeded(counter: number) {
        if (counter % REFILL_INTERVAL === 0) {
            agent.setItem(TEXT_BLOCK, 64, 1)
            agent.setSlot(1)
        }
    }

    // ---- 連結 "16x16:HEX64" を左から抽出（非HEX混入のエントリは破棄）----
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
                // HEXのみ許容。空白や記号等が来たらこの1件は破棄
                if ((c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F")) {
                    hex += c; k++
                } else { aborted = true; k++; break }
            }
            if (!aborted && hex.length === needHex) {
                const bmp = parseHeader(needle + hex) // 16x16固定としてデコード
                if (bmp) out.push(bmp)
                i = k
            } else {
                if (k >= n) break
                i = k
            }
        }
        return out
    }

    // 1) エージェントに…ブロック
    //% blockId=kc_write_agent_here
    //% block="エージェントに 文字 %code を %plane に 今いる場所から書いてもらう"
    //% plane.defl=Plane.Floor
    //% weight=90 blockNamespace="kanjiCraft"
    export function agentWriteHere(code: string, plane: Plane) {
        // 1) 原点＝エージェントの今いる位置
        const origin = agent.getPosition()
        if (!origin) { player.say("エージェントの位置が取得できません"); return }

        // 2) 連結16x16の抽出（例：複数行にまたがる "16x16:... 16x16:..." に対応）
        const many = parseMany16(code)
        if (many.length === 0) {
            const bmp0 = parseHeader(code)
            if (!bmp0) return
            many.push(bmp0)
        }

        // 3) 在庫初期投入（以降は ensureAgentStockIfNeeded に任せる）
        agent.setItem(TEXT_BLOCK, 64, 1)
        agent.setSlot(1)

        let placed = 0
        let offsetX = 0

        if (plane === Plane.Wall) {
            // 壁：原点は左上、右へ+X、見た目下方向は -Y を写像解除
            for (let gi = 0; gi < many.length; gi++) {
                const bmp = many[gi]
                for (let y = 0; y < bmp.h; y++) {
                    for (let x = 0; x < bmp.w; x++) {
                        if (!bmp.bits[y][x]) continue
                        const target = posAtWall(origin, offsetX + x, y)
                        if (PLACE_ONLY_AIR && !isAir(target)) continue
                        const stand = positions.add(target, positions.create(0, 0, 1))
                        agent.teleport(stand, NORTH)
                        ensureAgentStockIfNeeded(placed)
                        agent.place(FORWARD)
                        placed++
                    }
                }
                offsetX += bmp.w + 1   // ← 字間1で横に並べる
            }
        } else {
            // 床：原点は左上、右へ+X、下へ+Z
            for (let gi = 0; gi < many.length; gi++) {
                const bmp = many[gi]
                for (let z = 0; z < bmp.h; z++) {
                    for (let x = 0; x < bmp.w; x++) {
                        if (!bmp.bits[z][x]) continue
                        const target = posAtFloor(origin, offsetX + x, z)
                        if (PLACE_ONLY_AIR && !isAir(target)) continue
                        const stand = positions.add(target, positions.create(0, 1, 0))
                        agent.teleport(stand, SOUTH)
                        ensureAgentStockIfNeeded(placed)
                        agent.place(DOWN)
                        placed++
                    }
                }
                offsetX += bmp.w + 1   // ← 字間1で横に並べる
            }
        }
    }
}