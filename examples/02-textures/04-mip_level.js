import GUI from "https://webgpufundamentals.org/3rdparty/muigui-0.x.module.js";

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
    label: "our hardcoded rgb triangle shaders",
    code: /* wgsl */ `
      struct OurVertexShaderOutput {
        @builtin(position) position: vec4f, 
        @location(0) texcoord: vec2f,
      };

      // save scale and offset of the quad in uniforms
      struct Uniforms {
        scale: vec2f,
        offset: vec2f,
      };
      
      @group(0) @binding(2) var<uniform> uni: Uniforms;

      @vertex fn vs(
        @builtin(vertex_index) vertexIndex : u32
      ) -> OurVertexShaderOutput {
        let pos = array(
          // 1st triangle
          vec2f( 0.0,  0.0),  // center
          vec2f( 1.0,  0.0),  // right, center
          vec2f( 0.0,  1.0),  // center, top
      
          // 2nd triangle
          vec2f( 0.0,  1.0),  // center, top
          vec2f( 1.0,  0.0),  // right, center
          vec2f( 1.0,  1.0),  // right, top
        );
 
        var vsOutput: OurVertexShaderOutput;
        let xy = pos[vertexIndex];
        vsOutput.position = vec4f(xy * uni.scale + uni.offset, 0.0, 1.0);
        vsOutput.texcoord = xy;
        return vsOutput;
      }

      @group(0) @binding(0) var ourSampler: sampler;
      @group(0) @binding(1) var ourTexture: texture_2d<f32>;
 
      @fragment fn fs(fsInput: OurVertexShaderOutput) -> @location(0) vec4f {
        return textureSample(ourTexture, ourSampler, fsInput.texcoord);
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

  // Create a 5x7 texel for texture data
  const kTextureWidth = 5;
  const kTextureHeight = 7;
  const _ = [255, 0, 0, 255]; // red
  const y = [255, 255, 0, 255]; // yellow
  const b = [0, 0, 255, 255]; // blue

  // the texture data is flipped vertically because texture coordinates are flipped
  // prettier-ignore
  const textureData = new Uint8Array([
    _, _, _, _, _,
    _, y, _, _, _,
    _, y, _, _, _,
    _, y, y, _, _,
    _, y, _, _, _,
    _, y, y, y, _,
    b, _, _, _, _,
  ].flat());

  const lerp = (a, b, t) => a + (b - a) * t;
  const mix = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
  const bilinearFilter = (tl, tr, bl, br, t1, t2) => {
    const t = mix(tl, tr, t1);
    const b = mix(bl, br, t1);
    return mix(t, b, t2);
  };

  const createNextMipLevelRgba8Unorm = ({
    data: src,
    width: srcWidth,
    height: srcHeight,
  }) => {
    // compute the size of the next mip
    const dstWidth = Math.max(1, (srcWidth / 2) | 0);
    const dstHeight = Math.max(1, (srcHeight / 2) | 0);
    const dst = new Uint8Array(dstWidth * dstHeight * 4);

    const getSrcPixel = (x, y) => {
      const offset = (y * srcWidth + x) * 4;
      return src.subarray(offset, offset + 4);
    };

    for (let y = 0; y < dstHeight; ++y) {
      for (let x = 0; x < dstWidth; ++x) {
        // compute texcoord of the center of the destination texel
        const u = (x + 0.5) / dstWidth;
        const v = (y + 0.5) / dstHeight;

        // compute the same texcoord in the source - 0.5 a pixel
        const au = u * srcWidth - 0.5;
        const av = v * srcHeight - 0.5;

        // compute the src top left texel coord (not texcoord)
        const tx = au | 0;
        const ty = av | 0;

        // compute the mix amounts between pixels
        const t1 = au % 1;
        const t2 = av % 1;

        // get the 4 pixels
        const tl = getSrcPixel(tx, ty);
        const tr = getSrcPixel(tx + 1, ty);
        const bl = getSrcPixel(tx, ty + 1);
        const br = getSrcPixel(tx + 1, ty + 1);

        // copy the "sampled" result into the dest.
        const dstOffset = (y * dstWidth + x) * 4;
        dst.set(bilinearFilter(tl, tr, bl, br, t1, t2), dstOffset);
      }
    }
    return { data: dst, width: dstWidth, height: dstHeight };
  };

  const generateMips = (src, srcWidth) => {
    const srcHeight = src.length / 4 / srcWidth;

    // populate with first mip level (base level)
    let mip = { data: src, width: srcWidth, height: srcHeight };
    const mips = [mip];

    while (mip.width > 1 || mip.height > 1) {
      mip = createNextMipLevelRgba8Unorm(mip);
      mips.push(mip);
    }
    return mips;
  };

  const mips = generateMips(textureData, kTextureWidth);

  // Create texture
  const texture = device.createTexture({
    label: "yellow F on red",
    size: [mips[0].width, mips[0].height],
    mipLevelCount: mips.length,
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  mips.forEach(({ data, width, height }, mipLevel) => {
    device.queue.writeTexture(
      { texture, mipLevel },
      data,
      { bytesPerRow: width * 4 },
      { width, height },
    );
  });

  // create a buffer for the uniform values
  const uniformBufferSize =
    2 * 4 + // scale is 2 32bit floats (4bytes each)
    2 * 4; // offset is 2 32bit floats (4bytes each)
  const uniformBuffer = device.createBuffer({
    label: "uniforms for quad",
    size: uniformBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // create a typedarray to hold the values for the uniforms in JavaScript
  const uniformValues = new Float32Array(uniformBufferSize / 4);

  // offsets to the various uniform values in float32 indices
  const kScaleOffset = 0;
  const kOffsetOffset = 2;

  // Create bind groups for each sampler address mode
  const bindGroups = [];
  for (let i = 0; i < 16; ++i) {
    const sampler = device.createSampler({
      addressModeU: i & 1 ? "repeat" : "clamp-to-edge",
      addressModeV: i & 2 ? "repeat" : "clamp-to-edge",
      magFilter: i & 4 ? "linear" : "nearest",
      minFilter: i & 8 ? "linear" : "nearest",
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: texture },
        { binding: 2, resource: uniformBuffer },
      ],
    });
    bindGroups.push(bindGroup);
  }

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

  const settings = {
    addressModeU: "repeat",
    addressModeV: "repeat",
    magFilter: "linear",
    minFilter: "linear",
    scale: 1,
  };

  const addressOptions = ["repeat", "clamp-to-edge"];
  const filterOptions = ["nearest", "linear"];

  const gui = new GUI();
  Object.assign(gui.domElement.style, { right: "", left: "15px" });
  gui.add(settings, "addressModeU", addressOptions);
  gui.add(settings, "addressModeV", addressOptions);
  gui.add(settings, "magFilter", filterOptions);
  gui.add(settings, "minFilter", filterOptions);
  gui.add(settings, "scale", 0.5, 6);

  // render pass
  function render(time) {
    time *= 0.001;
    const ndx =
      (settings.addressModeU === "repeat" ? 1 : 0) +
      (settings.addressModeV === "repeat" ? 2 : 0) +
      (settings.magFilter === "linear" ? 4 : 0) +
      (settings.minFilter === "linear" ? 8 : 0);
    const bindGroup = bindGroups[ndx];

    // compute a scale that will draw our 0 to 1 clip space quad
    // 2x2 pixels in the canvas.
    const scaleX = (4 / canvas.width) * settings.scale;
    const scaleY = (4 / canvas.height) * settings.scale;

    uniformValues.set([scaleX, scaleY], kScaleOffset); // set the scale
    uniformValues.set([Math.sin(time * 0.25) * 0.8, -0.8], kOffsetOffset); // set the offset

    // copy the values from JavaScript to the GPU
    device.queue.writeBuffer(uniformBuffer, 0, uniformValues);

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
    pass.setBindGroup(0, bindGroup);
    pass.draw(6); // call our vertex shader 6 times
    pass.end();

    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);

    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  // re-render when the canvas resizes
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const canvas = entry.target;
      // lower the resolution to avoid flickering when using minFilter sampler
      const width = (entry.contentBoxSize[0].inlineSize / 64) | 0;
      const height = (entry.contentBoxSize[0].blockSize / 64) | 0;
      canvas.width = Math.max(
        1,
        Math.min(width, device.limits.maxTextureDimension2D),
      );
      canvas.height = Math.max(
        1,
        Math.min(height, device.limits.maxTextureDimension2D),
      );
    }
  });
  observer.observe(canvas);
}

function fail(msg) {
  // eslint-disable-next-line no-alert
  alert(msg);
}

main();
