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

  const k = {
    chunkWidth: 256,
    chunkHeight: 1,
  };
  const sharedConstants = Object.entries(k)
    .map(([k, v]) => `const ${k} = ${v};`)
    .join("\n");

  const histogramChunkModule = device.createShaderModule({
    label: "histogram chunk shader",
    code: /* wgsl */ `
      ${sharedConstants}  // const chunkWidth = 256; const chunkHeight = 1;
      const chunkSize = chunkWidth * chunkHeight;

      var<workgroup> bins: array<atomic<u32>, chunkSize>; // buffer in each workgroup
      @group(0) @binding(0) var<storage, read_write> chunks: array<array<u32, chunkSize>>;  // buffer across all workgroups
      @group(0) @binding(1) var ourTexture: texture_2d<f32>;
 
      // from: https://www.w3.org/WAI/GL/wiki/Relative_luminance
      const kSRGBLuminanceFactors = vec3f(0.2126, 0.7152, 0.0722);
      fn srgbLuminance(color: vec3f) -> f32 {
        return saturate(dot(color, kSRGBLuminanceFactors));
      }
 
      @compute @workgroup_size(chunkWidth, chunkHeight, 1)
      fn cs(
        @builtin(global_invocation_id) global_invocation_id: vec3u,
        @builtin(workgroup_id) workgroup_id: vec3u,
        @builtin(local_invocation_id) local_invocation_id: vec3u,
      ) {
        let size = textureDimensions(ourTexture, 0);
        let position = global_invocation_id.xy; 
        if (all(position < size)) {
          let numBins = f32(chunkSize);
          let lastBinIndex = u32(numBins - 1);
          let color = textureLoad(ourTexture, position, 0);
          let v = srgbLuminance(color.rgb);
          let bin = min(u32(v * numBins), lastBinIndex);
          atomicAdd(&bins[bin], 1u);
        }

        // gather results from all workgroups
        workgroupBarrier();
 
        let chunksAcross = (size.x + chunkWidth - 1) / chunkWidth;
        let chunk = workgroup_id.y * chunksAcross + workgroup_id.x;
        let bin = local_invocation_id.y * chunkWidth + local_invocation_id.x;
      
        chunks[chunk][bin] = atomicLoad(&bins[bin]);
      }
    `,
  });

  const chunkSumModule = device.createShaderModule({
    label: "chunk sum shader",
    code: /* wgsl */ `
      ${sharedConstants}
      const chunkSize = chunkWidth * chunkHeight;

      struct Uniforms {
        stride: u32,
      };

      @group(0) @binding(0) var<storage, read_write> chunks: array<array<u32, chunkSize>>;
      @group(0) @binding(1) var<uniform> uni: Uniforms;
  
      @compute @workgroup_size(chunkSize, 1, 1)
      fn cs(
        @builtin(local_invocation_id) local_invocation_id: vec3u,
        @builtin(workgroup_id) workgroup_id: vec3u,
      ) {
        // reduce with a stride
        let chunk0 = workgroup_id.x * uni.stride * 2;
        let chunk1 = chunk0 + uni.stride;
  
        let sum = chunks[chunk0][local_invocation_id.x] +
                  chunks[chunk1][local_invocation_id.x];
        chunks[chunk0][local_invocation_id.x] = sum;
      }
    `,
  });

  const histogramChunkPipeline = device.createComputePipeline({
    label: "histogram",
    layout: "auto",
    compute: {
      module: histogramChunkModule,
    },
  });

  const chunkSumPipeline = device.createComputePipeline({
    label: "chunk sum",
    layout: "auto",
    compute: {
      module: chunkSumModule,
    },
  });

  const imgBitmap = await loadImageBitmap(
    "https://webgpufundamentals.org/webgpu/resources/images/pexels-francesco-ungaro-96938-mid.jpg",
  );
  const texture = createTextureFromSource(device, imgBitmap);

  // Prepare storage buffer to store results
  const chunkSize = k.chunkWidth * k.chunkHeight;
  const chunksAcross = Math.ceil(texture.width / k.chunkWidth);
  const chunksDown = Math.ceil(texture.height / k.chunkHeight);
  const numChunks = chunksAcross * chunksDown;
  const chunksBuffer = device.createBuffer({
    size: numChunks * chunkSize * 4, // 4 bytes per (u32)
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // Prepare a mappable buffer to read back results
  const resultBuffer = device.createBuffer({
    size: chunkSize * 4, // 4 bytes per (u32)
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  // Create a bind group to pass the buffers and texture
  const histogramBindGroup = device.createBindGroup({
    label: "histogram bindGroup",
    layout: histogramChunkPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: chunksBuffer },
      { binding: 1, resource: texture },
    ],
  });

  // Create bind groups for reducing the chunks
  const sumBindGroups = [];
  const numSteps = Math.ceil(Math.log2(numChunks));
  for (let i = 0; i < numSteps; ++i) {
    const stride = 2 ** i;
    const uniformBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true,
    });
    new Uint32Array(uniformBuffer.getMappedRange()).set([stride]);
    uniformBuffer.unmap();

    const chunkSumBindGroup = device.createBindGroup({
      layout: chunkSumPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: chunksBuffer },
        { binding: 1, resource: uniformBuffer },
      ],
    });
    sumBindGroups.push(chunkSumBindGroup);
  }

  // Encode commands to do the computation
  const encoder = device.createCommandEncoder({ label: "histogram encoder" });
  const pass = encoder.beginComputePass();

  // create a histogram for each area
  pass.setPipeline(histogramChunkPipeline);
  pass.setBindGroup(0, histogramBindGroup);
  pass.dispatchWorkgroups(chunksAcross, chunksDown);

  // reduce the chunks
  pass.setPipeline(chunkSumPipeline);
  let chunksLeft = numChunks;
  sumBindGroups.forEach((bindGroup) => {
    pass.setBindGroup(0, bindGroup);
    const dispatchCount = Math.floor(chunksLeft / 2);
    chunksLeft -= dispatchCount;
    pass.dispatchWorkgroups(dispatchCount);
  });

  pass.end();

  // Copy results from storage buffer to mappable buffer
  encoder.copyBufferToBuffer(
    chunksBuffer,
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
