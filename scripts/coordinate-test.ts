import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type DisplayInfo = {
  displayId: string;
  name: string;
  pixelWidth: number;
  pixelHeight: number;
  logicalWidth: number;
  logicalHeight: number;
  globalX: number;
  globalY: number;
  scaleFactor: number;
  isPrimary: boolean;
};

type HelperResponse = {
  ok?: boolean;
  error?: string;
  displays?: DisplayInfo[];
  imageBase64?: string;
  width?: number;
  height?: number;
  pointerX?: number;
  pointerY?: number;
};

type Point = {
  label: string;
  x: number;
  y: number;
};

type TestOptions = {
  display: 'all' | number;
  move: boolean;
  modelFrameMode: 'native' | 'canonical';
  modelWidth: number;
  modelHeight: number;
  maxDimension: number;
};

const root = resolve(new URL('..', import.meta.url).pathname);
const helperPath = join(root, 'build', 'bin', 'LocalMacosHelper');
const outputDir = join(root, 'debug-logs', 'coordinate-test');

function parseArgs(): TestOptions {
  const options: TestOptions = {
    display: 'all',
    move: true,
    modelFrameMode: 'canonical',
    modelWidth: 1366,
    modelHeight: 768,
    maxDimension: 1920,
  };

  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    const next = process.argv[index + 1];
    if (arg === '--display' && next) {
      options.display = next === 'all' ? 'all' : Number(next);
      index += 1;
    } else if (arg === '--no-move') {
      options.move = false;
    } else if (arg === '--model-frame' && next) {
      if (next !== 'native' && next !== 'canonical') {
        throw new Error('--model-frame must be "native" or "canonical".');
      }
      options.modelFrameMode = next;
      index += 1;
    } else if (arg === '--model-width' && next) {
      options.modelWidth = Math.max(1, Number(next));
      index += 1;
    } else if (arg === '--model-height' && next) {
      options.modelHeight = Math.max(1, Number(next));
      index += 1;
    } else if (arg === '--max-dimension' && next) {
      options.maxDimension = Math.max(1, Number(next));
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (options.display !== 'all' && !Number.isInteger(options.display)) {
    throw new Error('--display must be "all" or a display index.');
  }

  return options;
}

function printHelp(): void {
  console.info([
    'Usage: pnpm coordinate-test -- [options]',
    '',
    'Options:',
    '  --display <all|index>       Display(s) to test. Default: all',
    '  --no-move                   Do not move the pointer; only capture metadata and print mapped targets.',
    '  --model-frame <mode>        native or canonical. Default: canonical',
    '  --model-width <pixels>      Canonical model frame width. Default: 1366',
    '  --model-height <pixels>     Canonical model frame height. Default: 768',
    '  --max-dimension <pixels>    Native-mode longest-edge limit. Default: 1920',
    '',
    'This never clicks. With movement enabled, it moves the pointer to known frame coordinates,',
    'reads the OS pointer position back, and reports conversion error in both global and frame space.',
  ].join('\n'));
}

function runHelper(args: string[]): HelperResponse {
  if (!existsSync(helperPath)) {
    throw new Error(`Missing helper binary at ${helperPath}. Run pnpm compile:swift first.`);
  }
  const stdout = execFileSync(helperPath, args, { encoding: 'utf8', timeout: 15000 });
  const response = JSON.parse(stdout || '{}') as HelperResponse;
  if (!response.ok) {
    throw new Error(response.error ?? `Helper command failed: ${args.join(' ')}`);
  }
  return response;
}

function frameSize(raw: { width: number; height: number }, options: TestOptions): { width: number; height: number } {
  if (options.modelFrameMode === 'canonical') {
    const originalAspect = raw.width / Math.max(raw.height, 1);
    const modelAspect = options.modelWidth / Math.max(options.modelHeight, 1);
    const canUseExactCanonical = raw.width >= options.modelWidth
      && raw.height >= options.modelHeight
      && Math.abs(originalAspect - modelAspect) / Math.max(modelAspect, 0.0001) < 0.01;
    if (canUseExactCanonical) return { width: options.modelWidth, height: options.modelHeight };
    const scale = Math.min(1, options.modelWidth / Math.max(raw.width, 1), options.modelHeight / Math.max(raw.height, 1));
    return {
      width: Math.round(raw.width * scale),
      height: Math.round(raw.height * scale),
    };
  }

  const longest = Math.max(raw.width, raw.height);
  if (longest <= options.maxDimension) return raw;
  const scale = options.maxDimension / longest;
  return {
    width: Math.round(raw.width * scale),
    height: Math.round(raw.height * scale),
  };
}

function frameToGlobal(point: Point, display: DisplayInfo, frame: { width: number; height: number }): { x: number; y: number } {
  return {
    x: Math.round(display.globalX + (point.x / Math.max(frame.width, 1)) * display.logicalWidth),
    y: Math.round(display.globalY + (point.y / Math.max(frame.height, 1)) * display.logicalHeight),
  };
}

function globalToFrame(point: { x: number; y: number }, display: DisplayInfo, frame: { width: number; height: number }): { x: number; y: number } {
  const localX = Math.max(0, Math.min(point.x - display.globalX, display.logicalWidth - 1));
  const localY = Math.max(0, Math.min(point.y - display.globalY, display.logicalHeight - 1));
  return {
    x: Math.round((localX / Math.max(display.logicalWidth, 1)) * frame.width),
    y: Math.round((localY / Math.max(display.logicalHeight, 1)) * frame.height),
  };
}

function testPoints(frame: { width: number; height: number }): Point[] {
  return [
    { label: 'apple-logo-ish', x: 18, y: 12 },
    { label: 'menu-row-high', x: 90, y: 34 },
    { label: 'menu-row-center', x: 90, y: 45 },
    { label: 'top-center', x: Math.round(frame.width / 2), y: 12 },
    { label: 'screen-center', x: Math.round(frame.width / 2), y: Math.round(frame.height / 2) },
    { label: 'bottom-center', x: Math.round(frame.width / 2), y: Math.max(0, frame.height - 20) },
  ].filter((point) => point.x >= 0 && point.x < frame.width && point.y >= 0 && point.y < frame.height);
}

function formatDelta(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}`;
}

async function main(): Promise<void> {
  const options = parseArgs();
  mkdirSync(outputDir, { recursive: true });

  const layout = runHelper(['displays']);
  const displays = layout.displays ?? [];
  const selectedDisplays = displays
    .map((display, index) => ({ display, index }))
    .filter(({ index }) => options.display === 'all' || options.display === index);

  if (selectedDisplays.length === 0) {
    throw new Error(`No displays matched ${String(options.display)}.`);
  }

  console.info(`Coordinate diagnostic: move=${options.move} modelFrame=${options.modelFrameMode} modelSize=${options.modelWidth}x${options.modelHeight} maxDimension=${options.maxDimension}`);
  console.info(`Output directory: ${outputDir}`);

  for (const { display, index } of selectedDisplays) {
    const screenshot = runHelper([
      'screenshot',
      Buffer.from('[]').toString('base64'),
      '0.85',
      String(index),
      String(process.pid),
    ]);

    if (!screenshot.imageBase64 || !screenshot.width || !screenshot.height) {
      throw new Error(`Display ${index} screenshot failed.`);
    }

    const rawFrame = { width: screenshot.width, height: screenshot.height };
    const frame = frameSize(rawFrame, options);
    const screenshotPath = join(outputDir, `display-${index}-${display.displayId}.jpg`);
    writeFileSync(screenshotPath, Buffer.from(screenshot.imageBase64, 'base64'));

    console.info('');
    console.info(`Display ${index}: ${display.name} id=${display.displayId} primary=${display.isPrimary}`);
    console.info(`  pixels=${display.pixelWidth}x${display.pixelHeight} logical=${display.logicalWidth}x${display.logicalHeight} global=(${display.globalX},${display.globalY}) scale=${display.scaleFactor}`);
    console.info(`  screenshot=${rawFrame.width}x${rawFrame.height} modelFrame=${frame.width}x${frame.height} saved=${screenshotPath}`);
    console.info('  point              frame target     global target    actual global    actual frame     error');

    for (const point of testPoints(frame)) {
      const expectedGlobal = frameToGlobal(point, display, frame);
      let actualGlobal = expectedGlobal;
      let actualFrame = point;

      if (options.move) {
        runHelper(['move', String(expectedGlobal.x), String(expectedGlobal.y), '40', '1', 'teleport']);
        const pointer = runHelper(['pointer']);
        if (typeof pointer.pointerX !== 'number' || typeof pointer.pointerY !== 'number') {
          throw new Error('Pointer readback failed.');
        }
        actualGlobal = {
          x: Math.round(pointer.pointerX),
          y: Math.round(pointer.pointerY),
        };
        actualFrame = globalToFrame(actualGlobal, display, frame);
      }

      const globalDx = actualGlobal.x - expectedGlobal.x;
      const globalDy = actualGlobal.y - expectedGlobal.y;
      const frameDx = actualFrame.x - point.x;
      const frameDy = actualFrame.y - point.y;
      console.info(
        `  ${point.label.padEnd(17)} `
        + `${String(`(${point.x},${point.y})`).padEnd(16)} `
        + `${String(`(${expectedGlobal.x},${expectedGlobal.y})`).padEnd(16)} `
        + `${String(`(${actualGlobal.x},${actualGlobal.y})`).padEnd(16)} `
        + `${String(`(${actualFrame.x},${actualFrame.y})`).padEnd(16)} `
        + `global(${formatDelta(globalDx)},${formatDelta(globalDy)}) frame(${formatDelta(frameDx)},${formatDelta(frameDy)})`,
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
