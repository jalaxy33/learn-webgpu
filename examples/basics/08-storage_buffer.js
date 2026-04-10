// A random number between [min and max)
// With 1 argument it will be [0 to min)
// With no arguments it will be [0 to 1)
const rand = (min, max) => {
  if (min === undefined) {
    min = 0;
    max = 1;
  } else if (max === undefined) {
    max = min;
    min = 0;
  }
  return min + Math.random() * (max - min);
};

async function main() {
  const adapter = await navigator.gpu?.requestAdapter();
  const device = await adapter?.requestDevice();
  if (!device) {
    fail("need a browser that supports WebGPU");
    return;
  }

  // Get a WebGPU context from the canvas and configure it
  const canvas = document.querySelector("canvas");
  const context = canvas.getContext("webgpu");
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format: presentationFormat,
  });

  // Create a shader module
  const module = device.createShaderModule({
    label: "our hardcoded red triangle shaders",
    code: /* wgsl */ `
      // A struct to hold uniform values that won't change
      struct OurStruct {
        color: vec4f,
        offset: vec2f,
      };

      // A struct to hold changeable uniform values
      struct OtherStruct {
        scale: vec2f,
      };

      struct VSOutput {
        @builtin(position) position: vec4f,
        @location(0) color: vec4f,
      }

      @group(0) @binding(0) var<storage, read> ourStructs: array<OurStruct>;
      @group(0) @binding(1) var<storage, read> otherStructs: array<OtherStruct>;

      @vertex fn vs(
        @builtin(vertex_index) vertexIndex : u32,
        @builtin(instance_index) instanceIndex: u32 // the index of the object we are drawing
      ) -> VSOutput {
        let pos = array(
          vec2f( 0.0,  0.5),  // top center
          vec2f(-0.5, -0.5),  // bottom left
          vec2f( 0.5, -0.5)   // bottom right
        );

        let otherStruct = otherStructs[instanceIndex];
        let ourStruct = ourStructs[instanceIndex];
 
        var vsOut: VSOutput;
        vsOut.position = vec4f(
            pos[vertexIndex] * otherStruct.scale + ourStruct.offset, 0.0, 1.0);
        vsOut.color = ourStruct.color;
        return vsOut;
      }
 
      @fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
        return vsOut.color;
      }
    `,
  });

  // Create a render pipeline
  const pipeline = device.createRenderPipeline({
    label: "our hardcoded red triangle pipeline",
    layout: "auto",
    vertex: {
      //   entryPoint: "vs",
      module,
    },
    fragment: {
      //   entryPoint: "fs",
      module,
      targets: [{ format: presentationFormat }],
    },
  });

  const kNumObjects = 100;
  const objectInfos = [];

  // create 2 storage buffers
  const staticUnitSize =
    4 * 4 + // color is 4 32bit floats (4bytes each)
    2 * 4 + // offset is 2 32bit floats (4bytes each)
    2 * 4; // padding
  const changingUnitSize = 2 * 4; // scale is 2 32bit floats (4bytes each)
  const staticStorageBufferSize = staticUnitSize * kNumObjects;
  const changingStorageBufferSize = changingUnitSize * kNumObjects;

  const staticStorageBuffer = device.createBuffer({
    label: "static storage for objects",
    size: staticStorageBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const changingStorageBuffer = device.createBuffer({
    label: "changing storage for objects",
    size: changingStorageBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // offsets to the various uniform values in float32 indices
  const kColorOffset = 0;
  const kOffsetOffset = 4;

  const kScaleOffset = 0;

  {
    const staticStorageValues = new Float32Array(staticStorageBufferSize / 4);
    for (let i = 0; i < kNumObjects; ++i) {
      const staticOffset = i * (staticUnitSize / 4);

      // These are only set once so set them now
      staticStorageValues.set(
        [rand(), rand(), rand(), 1],
        staticOffset + kColorOffset,
      ); // set the color
      staticStorageValues.set(
        [rand(-0.9, 0.9), rand(-0.9, 0.9)],
        staticOffset + kOffsetOffset,
      ); // set the offset

      objectInfos.push({
        scale: rand(0.2, 0.5),
      });
    }
    device.queue.writeBuffer(staticStorageBuffer, 0, staticStorageValues);
  }

  // a typed array we can use to update the changingStorageBuffer
  const storageValues = new Float32Array(changingStorageBufferSize / 4);

  // Note: we make just one bind group that references both buffers
  const bindGroup = device.createBindGroup({
    label: "bind group for objects",
    layout: pipeline.getBindGroupLayout(0), // corresponds to @group(0) in our shader
    entries: [
      // @binding(0) in shader
      { binding: 0, resource: staticStorageBuffer },
      // @binding(1) in shader
      { binding: 1, resource: changingStorageBuffer },
    ],
  });

  // Prepare a render pass descriptor
  const renderPassDescriptor = {
    label: "our basic canvas renderPass",
    colorAttachments: [
      {
        // view: <- to be filled out when we render
        clearValue: [0.3, 0.3, 0.3, 1],
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  };

  // render pass
  function render() {
    // Get the current texture from the canvas context and
    // set it as the texture to render to.
    renderPassDescriptor.colorAttachments[0].view = context
      .getCurrentTexture()
      .createView();

    // make a command encoder to start encoding commands
    const encoder = device.createCommandEncoder({ label: "our encoder" });

    // make a render pass encoder to encode render specific commands
    const pass = encoder.beginRenderPass(renderPassDescriptor);
    pass.setPipeline(pipeline);

    // Set the uniform values in our JavaScript side Float32Array
    const aspect = canvas.width / canvas.height;

    // set the scales for each object
    // Alternative to using for loop
    objectInfos.forEach(({ scale }, ndx) => {
      const offset = ndx * (changingUnitSize / 4);
      storageValues.set([scale / aspect, scale], offset + kScaleOffset); // set the scale
    });
    // upload all scales at once
    device.queue.writeBuffer(changingStorageBuffer, 0, storageValues);

    pass.setBindGroup(0, bindGroup);
    pass.draw(3, kNumObjects); // call our vertex shader 3 times for each instance
    pass.end();

    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);
  }
  // render();

  // re-render when the canvas resizes
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const canvas = entry.target;
      const width = entry.contentBoxSize[0].inlineSize;
      const height = entry.contentBoxSize[0].blockSize;
      canvas.width = Math.max(
        1,
        Math.min(width, device.limits.maxTextureDimension2D),
      );
      canvas.height = Math.max(
        1,
        Math.min(height, device.limits.maxTextureDimension2D),
      );
    }
    // re-render
    render();
  });
  observer.observe(canvas);
}

function fail(msg) {
  // eslint-disable-next-line no-alert
  alert(msg);
}

main();
