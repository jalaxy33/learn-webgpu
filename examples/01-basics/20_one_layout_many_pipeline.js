async function main() {
  const adapter = await navigator.gpu?.requestAdapter();
  const device = await adapter?.requestDevice();
  if (!device) {
    fail("need a browser that supports WebGPU");
    return;
  }

  // Create Compute shader modules
  const moduleTimes2 = device.createShaderModule({
    label: "doubling compute module",
    code: /* wgsl */ `
      @group(0) @binding(0) var<storage, read_write> data: array<f32>;
 
      @compute @workgroup_size(1) fn computeSomething(
        @builtin(global_invocation_id) id: vec3u
      ) {
        let i = id.x;
        data[i] = data[i] * 2.0;
      }
    `,
  });

  const modulePlus3 = device.createShaderModule({
    label: "adding 3 compute module",
    code: /* wgsl */ `
      @group(0) @binding(0) var<storage, read_write> data: array<f32>;
 
      @compute @workgroup_size(1) fn computeSomething(
        @builtin(global_invocation_id) id: vec3u
      ) {
        let i = id.x;
        data[i] = data[i] + 3.0;
      }
    `,
  });

  // Create bindgroup layout for sharing data between pipelines
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
          minBindingSize: 0,
        },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  // Create compute pipelines
  const pipelineTimes2 = device.createComputePipeline({
    label: "doubling compute pipeline",
    layout: pipelineLayout, // use the same pipeline layout instead of "auto"
    compute: {
      module: moduleTimes2,
    },
  });

  const pipelinePlus3 = device.createComputePipeline({
    label: "plus 3 compute pipeline",
    layout: pipelineLayout,
    compute: {
      module: modulePlus3,
    },
  });

  // prepare some data to process
  const input = new Float32Array([1, 3, 5]);

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
    layout: bindGroupLayout, // corresponds to @group(0) in the shader
    entries: [
      {
        binding: 0, // corresponds to @binding(0) in the shader
        resource: workBuffer,
      },
    ],
  });

  // Encode commands to do the computation
  const encoder = device.createCommandEncoder({
    label: "doubling encoder",
  });
  const pass = encoder.beginComputePass({
    label: "doubling compute pass",
  });
  pass.setPipeline(pipelineTimes2); // use the first pipeline
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(input.length);
  pass.setPipeline(pipelinePlus3); // use the second pipeline
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

  console.log("input", input); // [1, 3, 5]
  console.log("result", result); // input * 2 + 3 => [5, 9, 13]

  resultBuffer.unmap(); // After unmapping, the resultBuffer is no longer valid
}

function fail(msg) {
  // eslint-disable-next-line no-alert
  alert(msg);
}

main();
