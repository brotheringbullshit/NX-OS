import { BinaryReader, BinaryWriter, verifyTrailingCrc32 } from './binaryStructs';
import { sha256HexSync } from './crc32';
import { VmTelemetryResult } from './nandTypes';

export const NXVM_OP = {
  PUSH_I32: 0x01,
  LOAD_REG: 0x02,
  ADD: 0x10,
  SUB: 0x11,
  MUL: 0x12,
  DIV: 0x13,
  CLAMP: 0x14,
  STORE_OUT: 0x20,
  HALT: 0xff,
} as const;

export const NXVM_REG = {
  BAT_CAPACITY_MAH: 0,
  BAT_CYCLES: 1,
  BAT_RESIST_MOHM: 2,
  SET_BRIGHTNESS: 3,
  SET_AIRPLANE: 4,
  SET_DOCKED: 5,
  PROD_FUSES: 6,
} as const;

export const NXVM_OUT = {
  BATTERY_PERCENT: 0,
  EST_MINUTES: 1,
  HEALTH_PERCENT: 2,
} as const;

class VmAsm {
  private code: number[] = [];

  push(val: number): this {
    this.code.push(NXVM_OP.PUSH_I32);
    const buf = new ArrayBuffer(4);
    new DataView(buf).setInt32(0, val | 0, true);
    const bytes = new Uint8Array(buf);
    this.code.push(bytes[0], bytes[1], bytes[2], bytes[3]);
    return this;
  }

  loadReg(reg: number): this {
    this.code.push(NXVM_OP.LOAD_REG, reg & 0xff);
    return this;
  }

  add(): this {
    this.code.push(NXVM_OP.ADD);
    return this;
  }

  sub(): this {
    this.code.push(NXVM_OP.SUB);
    return this;
  }

  mul(): this {
    this.code.push(NXVM_OP.MUL);
    return this;
  }

  div(): this {
    this.code.push(NXVM_OP.DIV);
    return this;
  }

  clamp(min: number, max: number): this {
    this.push(min);
    this.push(max);
    this.code.push(NXVM_OP.CLAMP);
    return this;
  }

  storeOut(slot: number): this {
    this.code.push(NXVM_OP.STORE_OUT, slot & 0xff);
    return this;
  }

  halt(): Uint8Array {
    this.code.push(NXVM_OP.HALT);
    return new Uint8Array(this.code);
  }
}

/**
 * Compiles Horizon-NX's power & battery fuel-gauge estimation policy
 * into an NXVM binary module stored at /sys/code/battery_policy.nxb on SYSTEM NAND.
 */
export function buildBatteryPolicyVmBinary(): Uint8Array {
  const asm = new VmAsm();

  // 1. Battery Health % = clamp(100 - (cycles / 25) - ((r_mohm - 30) / 10), 60, 100)
  asm
    .push(100)
    .loadReg(NXVM_REG.BAT_CYCLES)
    .push(25)
    .div()
    .sub()
    .loadReg(NXVM_REG.BAT_RESIST_MOHM)
    .push(30)
    .sub()
    .push(10)
    .div()
    .sub()
    .clamp(60, 100)
    .storeOut(NXVM_OUT.HEALTH_PERCENT);

  // 2. Displayed Charge % = clamp(96 - ((brightness - 50) / 15) + (docked * 4) + (airplane * 2), 15, 100)
  asm
    .push(96)
    .loadReg(NXVM_REG.SET_BRIGHTNESS)
    .push(50)
    .sub()
    .push(15)
    .div()
    .sub()
    .loadReg(NXVM_REG.SET_DOCKED)
    .push(4)
    .mul()
    .add()
    .loadReg(NXVM_REG.SET_AIRPLANE)
    .push(2)
    .mul()
    .add()
    .clamp(15, 100)
    .storeOut(NXVM_OUT.BATTERY_PERCENT);

  // 3. Estimated Minutes = clamp(capacityMah / (12 + (brightness / 15) - (airplane * 2)), 60, 600)
  asm
    .loadReg(NXVM_REG.BAT_CAPACITY_MAH)
    .push(12)
    .loadReg(NXVM_REG.SET_BRIGHTNESS)
    .push(15)
    .div()
    .add()
    .loadReg(NXVM_REG.SET_AIRPLANE)
    .push(2)
    .mul()
    .sub()
    .div()
    .clamp(60, 600)
    .storeOut(NXVM_OUT.EST_MINUTES);

  const bytecode = asm.halt();

  const w = new BinaryWriter(256);
  w.writeMagic('NXVM');
  w.writeU16(1); // VM ABI v1
  w.writeU16(bytecode.length);
  w.writeFixedString('battery_policy', 24);
  w.writeBytes(bytecode);
  return w.finishWithCrc32();
}

export function executeBatteryPolicyVm(
  programBytes: Uint8Array,
  registers: Record<number, number>
): VmTelemetryResult {
  verifyTrailingCrc32(programBytes, 'SYSTEM NXVM');
  const r = new BinaryReader(programBytes);
  const magic = r.readMagic(4);
  if (magic !== 'NXVM') {
    throw new Error(`Invalid NXVM bytecode magic "${magic}"`);
  }
  const abiVersion = r.readU16();
  if (abiVersion !== 1) {
    throw new Error(`Unsupported NXVM ABI v${abiVersion}`);
  }
  const codeLen = r.readU16();
  r.readFixedString(24); // module name
  const code = r.readBytes(codeLen);
  const view = new DataView(code.buffer, code.byteOffset, code.byteLength);

  const stack: number[] = [];
  const outputs: Record<number, number> = {};
  let pc = 0;
  let steps = 0;

  while (pc < code.length && steps < 512) {
    const op = code[pc++];
    steps++;

    if (op === NXVM_OP.HALT) {
      break;
    } else if (op === NXVM_OP.PUSH_I32) {
      if (pc + 4 > code.length) throw new Error('NXVM PUSH_I32 out of bounds');
      stack.push(view.getInt32(pc, true));
      pc += 4;
    } else if (op === NXVM_OP.LOAD_REG) {
      if (pc + 1 > code.length) throw new Error('NXVM LOAD_REG out of bounds');
      const reg = code[pc++];
      stack.push(Math.trunc(registers[reg] ?? 0));
    } else if (op === NXVM_OP.ADD) {
      const b = stack.pop() ?? 0;
      const a = stack.pop() ?? 0;
      stack.push((a + b) | 0);
    } else if (op === NXVM_OP.SUB) {
      const b = stack.pop() ?? 0;
      const a = stack.pop() ?? 0;
      stack.push((a - b) | 0);
    } else if (op === NXVM_OP.MUL) {
      const b = stack.pop() ?? 0;
      const a = stack.pop() ?? 0;
      stack.push((a * b) | 0);
    } else if (op === NXVM_OP.DIV) {
      const b = stack.pop() ?? 1;
      const a = stack.pop() ?? 0;
      stack.push(b === 0 ? 0 : Math.trunc(a / b));
    } else if (op === NXVM_OP.CLAMP) {
      const hi = stack.pop() ?? 100;
      const lo = stack.pop() ?? 0;
      const val = stack.pop() ?? 0;
      stack.push(Math.max(lo, Math.min(hi, val)));
    } else if (op === NXVM_OP.STORE_OUT) {
      if (pc + 1 > code.length) throw new Error('NXVM STORE_OUT out of bounds');
      const slot = code[pc++];
      outputs[slot] = stack.pop() ?? 0;
    } else {
      throw new Error(`NXVM illegal opcode 0x${op.toString(16).toUpperCase()}`);
    }
  }

  return {
    batteryPercent: outputs[NXVM_OUT.BATTERY_PERCENT] ?? 90,
    estimatedMinutesLeft: outputs[NXVM_OUT.EST_MINUTES] ?? 240,
    healthPercent: outputs[NXVM_OUT.HEALTH_PERCENT] ?? 95,
    instructionsExecuted: steps,
    programSha256: sha256HexSync(programBytes),
  };
}
