//% color=#3D7EFF weight=80 icon="\uf031" block="漢字クラフト"
namespace kanjiCraft {

    const TEXT_BLOCK = IRON_BLOCK      // 文字ブロック（必要なら変更）

    export enum Plane {
        //% block="壁（X-Y 平面）"
        Wall = 0,
        //% block="床（X-Z 平面）"
        Floor = 1
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

    // ---- "16x16:..." → ビット配列 ----
    function parseHeader(code: string): { w: number, h: number, bits: number[][] } {
        if (!code || code.length < 5) { player.say("コードが空です"); return null }

        let idxX = code.indexOf("x"); if (idxX < 0) idxX = code.indexOf("X")
        const idxColon = code.indexOf(":")
        if (idxX <= 0 || idxColon < 0 || idxColon <= idxX + 1) {
            player.say("形式は 16x16:HEX... のようにしてください")
            return null
        }

        const wStr = slice_(code, 0, idxX)
        const hStr = slice_(code, idxX + 1, idxColon)
        const hex = slice_(code, idxColon + 1, code.length)

        if (!isDigits(wStr) || !isDigits(hStr)) { player.say("サイズが数字ではありません"); return null }
        const w = parseInt(wStr), h = parseInt(hStr)
        if (w <= 0 || h <= 0 || w > 64 || h > 64) { player.say("サイズは1〜64にしてください"); return null }
        if (!isHexString(hex)) { player.say("HEX以外の文字が混在しています"); return null }

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
    // 壁：画像yは下へ+, MinecraftのYは上へ+ なので「-y」で写像（上下反転を打ち消す）
    function posAtWall(origin: Position, x: number, y: number): Position {
        return positions.add(origin, positions.create(x, -y, 0))
    }
    // 床：画像yは"奥方向"として Z を + に進める
    function posAtFloor(origin: Position, x: number, z: number): Position {
        return positions.add(origin, positions.create(x, 0, z))
    }

    // ---- 1) エージェントに置かせる（厚み=1固定）----
    //% blockId=kc_write_agent
    //% block="エージェントに 文字 %code を %plane で %origin から書いてもらう"
    //% weight=90 blockNamespace="kanjiCraft"
    export function agentWrite(code: string, plane: Plane, origin: Position) {
        const bmp = parseHeader(code)
        if (!bmp) return

        // ブロック配布＆選択（スロット1）
        agent.setItem(TEXT_BLOCK, 64, 1)
        agent.setSlot(1)

        if (plane === Plane.Wall) {
            for (let y = 0; y < bmp.h; y++) {
                for (let x = 0; x < bmp.w; x++) {
                    if (!bmp.bits[y][x]) continue
                    const target = posAtWall(origin, x, y)                           // 置きたい座標(Z=0基準)
                    const stand = positions.add(target, positions.create(0, 0, 1))  // 1ブロック手前(Z+1)に立つ
                    agent.teleport(stand, NORTH)                                     // 前方は -Z
                    agent.place(FORWARD)                                             // 前に1つ置く → target
                }
            }
        } else { // Floor
            for (let z = 0; z < bmp.h; z++) {
                for (let x = 0; x < bmp.w; x++) {
                    if (!bmp.bits[z][x]) continue
                    const target = posAtFloor(origin, x, z)                          // 置きたい座標
                    const stand = positions.add(target, positions.create(0, 1, 0))   // 1ブロック上から
                    agent.teleport(stand, SOUTH)
                    agent.place(DOWN)                                                // 真下に置く → target
                }
            }
        }
    }

    // ---- 2) ビルダー高速配置（厚み可変）----
    //% blockId=kc_place_builder
    //% block="文字 %code を %plane で %origin から 厚み %thickness で配置"
    //% thickness.min=1 thickness.max=32
    //% weight=80 blockNamespace="kanjiCraft"
    export function builderPlace(code: string, plane: Plane, origin: Position, thickness: number) {
        const bmp = parseHeader(code)
        if (!bmp) return
        if (thickness < 1) thickness = 1

        if (plane === Plane.Wall) {
            // 壁は +Z 方向に厚みを伸ばす（文字面がZ=0として）
            for (let y = 0; y < bmp.h; y++) {
                for (let x = 0; x < bmp.w; x++) {
                    if (!bmp.bits[y][x]) continue
                    const front = posAtWall(origin, x, y)                                  // Z=0
                    const back = positions.add(front, positions.create(0, 0, thickness - 1)) // 0..+t-1
                    blocks.fill(TEXT_BLOCK, front, back, FillOperation.Replace)
                }
            }
        } else {
            // 床は +Y 方向に厚みを伸ばす（面はXZ、原点は上面）
            for (let z = 0; z < bmp.h; z++) {
                for (let x = 0; x < bmp.w; x++) {
                    if (!bmp.bits[z][x]) continue
                    const top = posAtFloor(origin, x, z)                                   // Y=0
                    const bottom = positions.add(top, positions.create(0, thickness - 1, 0)) // 0..+t-1
                    blocks.fill(TEXT_BLOCK, top, bottom, FillOperation.Replace)
                }
            }
        }
    }
}
