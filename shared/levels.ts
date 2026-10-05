// Coarse levels (spec §8.6, K20): a pixel at level z + 1 is the per-channel average of its 2 × 2 children at z.
// Pure: the store derives levels 1-4 at each close with it, and the viewer may reuse it.
import { BLOCK, SIZE } from "./keys.js";

/** The per-channel average of four RGB565 pixels, rounded half up. */
export function average(a: number, b: number, c: number, d: number): number {
	const channel = (shift: number, mask: number) => {
		const sum = ((a >> shift) & mask) + ((b >> shift) & mask) + ((c >> shift) & mask) + ((d >> shift) & mask);
		return ((sum + 2) >> 2) << shift;
	};
	return channel(11, 31) | channel(5, 63) | channel(0, 31);
}

/** The parent block (at z + 1) that block `block` of area (ax, ay) at z shrinks into: a quadrant per child area. */
export function parentBlock(ax: number, ay: number, block: number): number {
	return (((ay & 1) * 8) + ((block >> 4) >> 1)) * 16 + ((ax & 1) * 8) + ((block & 15) >> 1);
}

/** Parent block `pb`'s 1,024 pixels, from `child`: the child area under it (its quadrant follows from pb). */
export function shrink(child: Uint16Array, pb: number): Uint16Array {
	const x0 = ((pb & 15) % 8) * 64;
	const y0 = ((pb >> 4) % 8) * 64;
	const out = new Uint16Array(BLOCK);
	for (let y = 0; y < 32; y++) {
		for (let x = 0; x < 32; x++) {
			const i = ((y0 + (2 * y)) * SIZE) + x0 + (2 * x);
			out[(y * 32) + x] = average(child[i], child[i + 1], child[i + SIZE], child[i + SIZE + 1]);
		}
	}
	return out;
}
