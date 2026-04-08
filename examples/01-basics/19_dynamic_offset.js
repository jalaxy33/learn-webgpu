async function main() {
  const adapter = await navigator.gpu?.requestAdapter();
  const device = await adapter?.requestDevice();
  if (!device) {
    fail("need a browser that supports WebGPU");
    return;
  }

  // Create a Compute shader module
  const module = device.createShaderModule({
    label: "doubling compute module",
    code: /* wgsl */ `
      @group(0) @binding(0) var<storage, read_write> a: array<f32>;
      @group(0) @binding(1) var<storage, read_write> b: array<f32>;
      @group(0) @binding(2) var<storage, read_write> dst: array<f32>;
      
      @compute @workgroup_size(1) fn computeSomething(
        @builtin(global_invocation_id) id: vec3u
      ) {
        let i = id.x;
        dst[i] = a[i] + b[i];
      }
    `,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0, // @binding(0) -> a
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
          // hasDynamicOffset allows us to use the same bind group
          // with different offsets into the buffer
          hasDynamicOffset: true,
        },
      },
      {
        binding: 1, // @binding(1) -> b
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
          hasDynamicOffset: true,
        },
      },
      {
        binding: 2, // @binding(2) -> dst
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
          hasDynamicOffset: true,
        },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout], // use the bind group layout we just created
  });

  // Create a compute pipeline
  const pipeline = device.createComputePipeline({
    label: "add elements compute pipeline",
    layout: pipelineLayout,
    compute: {
      module,
    },
  });

  // prepare some data to process
  //  Offset must be a multiple of 256 (64 * 4 bytes per float)
  //  so, let’s create a buffer 256 * 3 bytes large so we have at least 3 valid offsets:
  //  0、256 & 512
  //  which means we can store at most 64 floats at each subsection of the buffer (a, b and dst)
  const input = new Float32Array(64 * 3);
  input.set([1, 3, 5]); // set a
  input.set([11, 12, 13], 64); // set b

  // create a buffer on the GPU to hold our computation
  // input and output
  const workBuffer = device.createBuffer({
    label: "work buffer",
    size: input.byteLength,
    usage:
      GPUBufferUsage.STORAGE | // create a storage buffer
      GPUBufferUsage.COPY_SRC | // allow us to copy data from it
      GPUBufferUsage.COPY_DST, // allow us to copy data to it
  });
  // Copy our input data to that buffer
  device.queue.writeBuffer(workBuffer, 0, input);

  // create a buffer on the GPU to get a copy of the results
  const resultBuffer = device.createBuffer({
    label: "result buffer",
    size: input.byteLength,
    usage:
      GPUBufferUsage.MAP_READ | // allow us to map this buffer for reading data
      GPUBufferUsage.COPY_DST,
  });

  // Setup a bindGroup to tell the shader which
  // buffer to use for the computation
  const bindGroup = device.createBindGroup({
    label: "bindGroup for work buffer",
    layout: pipeline.getBindGroupLayout(0), // corresponds to @group(0) in the shader
    entries: [
      // bind the same buffer 3 times.
      { binding: 0, resource: { buffer: workBuffer, size: 256 } }, // a
      { binding: 1, resource: { buffer: workBuffer, size: 256 } }, // b
      { binding: 2, resource: { buffer: workBuffer, size: 256 } }, // dst
    ],
  });

  // Encode commands to do the computation
  const encoder = device.createCommandEncoder({
    label: "doubling encoder",
  });
  const pass = encoder.beginComputePass({
    label: "doubling compute pass",
  });
  pass.setPipeline(pipeline);
  // pass in offset for each buffer that has dynamic offsets
  // 0 -> a
  // 256 -> b (64 * 4 = 256)
  // 512 -> dst (256 + 256 = 512)
  pass.setBindGroup(0, bindGroup, [0, 256, 512]);
  pass.dispatchWorkgroups(input.length);
  pass.end();

  // Encode a command to copy the results to a mappable buffer.
  encoder.copyBufferToBuffer(workBuffer, 0, resultBuffer, 0, resultBuffer.size);

  // Finish encoding and submit the commands
  const commandBuffer = encoder.finish();
  device.queue.submit([commandBuffer]);

  // Read the results
  await resultBuffer.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(
    resultBuffer.getMappedRange(), // return an ArrayBuffer of the entire buffer
  );

  console.log("a", input.slice(0, 3));
  console.log("b", input.slice(64, 64 + 3));
  console.log("dst", result.slice(128, 128 + 3));

  resultBuffer.unmap(); // After unmapping, the resultBuffer is no longer valid
}

function fail(msg) {
  // eslint-disable-next-line no-alert
  alert(msg);
}

main();
