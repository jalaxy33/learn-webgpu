import {
  loadImageBitmap,
  createTextureFromSource,
} from "https://webgpufundamentals.org/3rdparty/webgpu-utils-1.x.module.js";

async function main() {
  const adapter = await navigator.gpu?.requestAdapter();
  const device = await adapter?.requestDevice();
  if (!device) {
    fail("need a browser that supports WebGPU");
    return;
  }

  const module = device.createShaderModule({
    label: "histogram shader",
    code: /* wgsl */ `
      @group(0) @binding(0) var<storage, read_write> bins: array<u32>;
      @group(0) @binding(1) var ourTexture: texture_2d<f32>;
 
      // from: https://www.w3.org/WAI/GL/wiki/Relative_luminance
      const kSRGBLuminanceFactors = vec3f(0.2126, 0.7152, 0.0722);
      fn srgbLuminance(color: vec3f) -> f32 {
        return saturate(dot(color, kSRGBLuminanceFactors));
      }
 
      @compute @workgroup_size(1) fn cs() {
        let size = textureDimensions(ourTexture, 0);
        let numBins = f32(arrayLength(&bins));
        let lastBinIndex = u32(numBins - 1);
        for (var y = 0u; y < size.y; y++) {
          for (var x = 0u; x < size.x; x++) {
            let position = vec2u(x, y);
            let color = textureLoad(ourTexture, position, 0);
            let v = srgbLuminance(color.rgb);
            let bin = min(u32(v * numBins), lastBinIndex);
            bins[bin] += 1;
          }
        }
      }
    `,
  });

  const pipeline = device.createComputePipeline({
    label: "histogram",
    layout: "auto",
    compute: {
      module,
    },
  });

  const imgBitmap = await loadImageBitmap(
    "https://webgpufundamentals.org/webgpu/resources/images/pexels-francesco-ungaro-96938-mid.jpg",
  );
  const texture = createTextureFromSource(device, imgBitmap);

  // Prepare storage buffer to store results
  const numBins = 256;
  const histogramBuffer = device.createBuffer({
    size: numBins * 4, // 256 entries * 4 bytes per (u32)
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // Prepare a mappable buffer to read back results
  const resultBuffer = device.createBuffer({
    size: histogramBuffer.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  // Create a bind group to pass the buffers and texture
  const bindGroup = device.createBindGroup({
    label: "histogram bindGroup",
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: histogramBuffer },
      { binding: 1, resource: texture },
    ],
  });

  // Encode commands to do the computation
  const encoder = device.createCommandEncoder({ label: "histogram encoder" });
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(1);
  pass.end();

  // Copy results from storage buffer to mappable buffer
  encoder.copyBufferToBuffer(
    histogramBuffer,
    0,
    resultBuffer,
    0,
    resultBuffer.size,
  );

  // Finish encoding and submit the commands
  const commandBuffer = encoder.finish();
  device.queue.submit([commandBuffer]);

  // Read the results
  await resultBuffer.mapAsync(GPUMapMode.READ);
  const histogram = new Uint32Array(resultBuffer.getMappedRange());

  showImageBitmap(imgBitmap);

  const numEntries = texture.width * texture.height;
  drawHistogram(histogram, numEntries);

  resultBuffer.unmap();
}

function showImageBitmap(imageBitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = imageBitmap.width;
  canvas.height = imageBitmap.height;

  const bm = canvas.getContext("bitmaprenderer");
  bm.transferFromImageBitmap(imageBitmap);
  document.body.appendChild(canvas);
}

function drawHistogram(histogram, numEntries, height = 100) {
  const numBins = histogram.length;
  const max = Math.max(...histogram);
  const scale = Math.max(1 / max, (0.2 * numBins) / numEntries);

  const canvas = document.createElement("canvas");
  canvas.width = numBins;
  canvas.height = height;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#fff";

  for (let x = 0; x < numBins; ++x) {
    const v = histogram[x] * scale * height;
    ctx.fillRect(x, height - v, 1, v);
  }
}

function fail(msg) {
  // eslint-disable-next-line no-alert
  alert(msg);
}

main();
