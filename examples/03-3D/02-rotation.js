import GUI from "https://webgpufundamentals.org/3rdparty/muigui-0.x.module.js";

function createFVertices() {
  // prettier-ignore
  const vertexData = new Float32Array([
    // left column
    0, 0,
    30, 0,
    0, 150,
    30, 150,
 
    // top rung
    30, 0,
    100, 0,
    30, 30,
    100, 30,
 
    // middle rung
    30, 60,
    70, 60,
    30, 90,
    70, 90,
  ]);

  // prettier-ignore
  const indexData = new Uint32Array([
    0,  1,  2,    2,  1,  3,  // left column
    4,  5,  6,    6,  5,  7,  // top run
    8,  9, 10,   10,  9, 11,  // middle run
  ]);

  return {
    vertexData,
    indexData,
    numVertices: indexData.length,
  };
}

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
    alphaMode: "premultiplied", // make the canvas transparent
  });

  // Create a shader module
  const module = device.createShaderModule({
    label: "our hardcoded red triangle shaders",
    code: /* wgsl */ `
        struct Uniforms {
          color: vec4f,
          resolution: vec2f,
          translation: vec2f,
          rotation: vec2f,
        };
        
        struct Vertex {
          @location(0) position: vec2f,
        };
        
        struct VSOutput {
          @builtin(position) position: vec4f,
        };
        
        @group(0) @binding(0) var<uniform> uni: Uniforms;
        
        @vertex fn vs(vert: Vertex) -> VSOutput {
          var vsOut: VSOutput;
          
          // Rotate the position
          let rotatedPosition = vec2f(
            vert.position.x * uni.rotation.x - vert.position.y * uni.rotation.y,
            vert.position.x * uni.rotation.y + vert.position.y * uni.rotation.x
          );

          // Add in the translation
          let position = rotatedPosition + uni.translation;
        
          // convert the position from pixels to a 0.0 to 1.0 value
          let zeroToOne = position / uni.resolution;
        
          // convert from 0 <-> 1 to 0 <-> 2
          let zeroToTwo = zeroToOne * 2.0;
        
          // covert from 0 <-> 2 to -1 <-> +1 (clip space)
          let flippedClipSpace = zeroToTwo - 1.0;
        
          // flip Y
          let clipSpace = flippedClipSpace * vec2f(1, -1);
        
          vsOut.position = vec4f(clipSpace, 0.0, 1.0);
          return vsOut;
        }
        
        @fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
          return uni.color;
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
      buffers: [
        {
          arrayStride: 2 * 4, // (2) floats, 4 bytes each
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" }, // position
          ],
        },
      ],
    },
    fragment: {
      //   entryPoint: "fs",
      module,
      targets: [{ format: presentationFormat }],
    },
  });

  // color, resolution, translation, rotation, padding
  const uniformBufferSize = (4 + 2 + 2 + 2) * 4 + 8;
  const uniformBuffer = device.createBuffer({
    label: "uniforms",
    size: uniformBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const uniformValues = new Float32Array(uniformBufferSize / 4);

  // offsets to the various uniform values in float32 indices
  const kColorOffset = 0;
  const kResolutionOffset = 4;
  const kTranslationOffset = 6;
  const kRotationOffset = 8;

  const colorValue = uniformValues.subarray(kColorOffset, kColorOffset + 4);
  const resolutionValue = uniformValues.subarray(
    kResolutionOffset,
    kResolutionOffset + 2,
  );
  const translationValue = uniformValues.subarray(
    kTranslationOffset,
    kTranslationOffset + 2,
  );
  const rotationValue = uniformValues.subarray(
    kRotationOffset,
    kRotationOffset + 2,
  );

  // The color will not change so let's set it once at init time
  colorValue.set([Math.random(), Math.random(), Math.random(), 1]);

  const { vertexData, indexData, numVertices } = createFVertices();
  const vertexBuffer = device.createBuffer({
    label: "vertex buffer vertices",
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertexData);
  const indexBuffer = device.createBuffer({
    label: "index buffer",
    size: indexData.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, indexData);

  const bindGroup = device.createBindGroup({
    label: "bind group for object",
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: uniformBuffer }],
  });

  // Prepare a render pass descriptor
  const renderPassDescriptor = {
    label: "our basic canvas renderPass",
    colorAttachments: [
      {
        // view: <- to be filled out when we render
        // clearValue: [0.3, 0.3, 0.3, 1],
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  };

  const degToRad = (d) => (d * Math.PI) / 180;

  const settings = {
    translation: [150, 150],
    rotation: degToRad(30),
  };

  const radToDegOptions = {
    min: -360,
    max: 360,
    step: 1,
    converters: GUI.converters.radToDeg,
  };

  const gui = new GUI();
  gui.onChange(render);
  gui.add(settings.translation, "0", 0, 1000).name("translation.x");
  gui.add(settings.translation, "1", 0, 1000).name("translation.y");
  gui.add(settings, "rotation", radToDegOptions);

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
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, "uint32");

    // Set the uniform values in our JavaScript side Float32Array
    resolutionValue.set([canvas.width, canvas.height]);
    translationValue.set(settings.translation);
    rotationValue.set([
      Math.cos(settings.rotation),
      Math.sin(settings.rotation),
    ]);

    // upload the uniform values to the uniform buffer
    device.queue.writeBuffer(uniformBuffer, 0, uniformValues);

    pass.setBindGroup(0, bindGroup);
    pass.drawIndexed(numVertices);

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
