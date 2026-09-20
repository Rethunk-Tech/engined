# llama.cpp server, Vulkan/RADV, gfx1151 (Strix Halo).
#
# What this tree owns is the recipe and llama-grammar.patch. The source is
# PrismML-Eng/llama.cpp (a fork of upstream llama.cpp, MIT) at the exact
# commit LLAMA_COMMIT names below -- the built image labels that commit, so a
# throughput measurement can be tied back to the source it was taken on.
#
# The fork rather than mainline for decode: measured warm on the same prompt,
# ornith runs 59.8 t/s on a mainline-based build against 64-69 here.
#
# Fedora, not rocm/dev-ubuntu like the sibling engines -- this is a Vulkan
# build (mesa-vulkan-drivers + the loader), not a ROCm/PyTorch one, so it
# doesn't need and doesn't take the ROCm base. See spec.toml: this engine
# takes only /dev/dri and deliberately not /dev/kfd, which is the same split
# reflected in the base image choice here.

# Global, so the final stage can label the same values without repeating them.
ARG REPO=https://github.com/PrismML-Eng/llama.cpp.git
# The head of the fork's `prism` branch as of this pin. A branch name here
# would let two builds of the same tree produce different llama.cpp with
# nothing recording which one a measurement was taken on.
ARG LLAMA_COMMIT=9a9394a895b96003ca842a6041cb28ac49a108f7

FROM registry.fedoraproject.org/fedora:46 AS builder

RUN dnf -y --nodocs --setopt=install_weak_deps=False install \
  git \
  make gcc gcc-c++ cmake ninja-build lld clang clang-devel compiler-rt libcurl-devel rdma-core-devel \
  vulkan-loader-devel vulkaninfo mesa-vulkan-drivers \
  spirv-headers-devel glslc patch \
  && dnf clean all && rm -rf /var/cache/dnf/*

WORKDIR /opt/llama.cpp
ARG REPO
ARG LLAMA_COMMIT
RUN git clone "${REPO}" . \
    && git checkout --detach "${LLAMA_COMMIT}" \
    && git submodule update --init --recursive

# MAX_REPETITION_THRESHOLD 2000 -> 100000: too low for complex tool-call
# grammars (json-schema-derived GBNF can legitimately need more repetitions).
COPY llama-grammar.patch /tmp/llama-grammar.patch
RUN patch -p1 < /tmp/llama-grammar.patch

# EXAMPLES=OFF here breaks the build (LLAMA_BUILD_SERVER depends on it in
# this fork's CMakeLists) -- confirmed by hitting exactly that failure.
#
# Vulkan alone. A ROCm backend built in beside it measured 54.1 t/s decode on
# ornith against Vulkan's 69.1, same prompt, and every route here decodes more
# than it prefills; ROCm's better prefill (113 t/s against 46) does not pay
# for that. Building both also means each route must pin `device`, since a
# route naming none gets whichever backend ggml ranks first.
RUN cmake -S . -B build -G Ninja \
    -DGGML_VULKAN=ON \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_RPC=ON \
    -DCMAKE_INSTALL_PREFIX=/usr \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=ON \
    -DLLAMA_BUILD_SERVER=ON \
    && cmake --build build --config Release \
    && cmake --install build --config Release

RUN find /opt/llama.cpp/build -type f -name 'lib*.so*' -exec cp {} /usr/lib64/ \; && ldconfig

FROM registry.fedoraproject.org/fedora-minimal:46
ARG REPO
ARG LLAMA_COMMIT
LABEL org.opencontainers.image.source="${REPO}" \
      org.opencontainers.image.revision="${LLAMA_COMMIT}"

RUN microdnf -y --nodocs --setopt=install_weak_deps=0 install \
  bash ca-certificates libatomic libstdc++ libgcc libgomp libibverbs \
  vulkan-loader mesa-vulkan-drivers \
  && microdnf clean all && rm -rf /var/cache/dnf/*

COPY --from=builder /usr/bin/llama-server /usr/bin/llama-server
COPY --from=builder /usr/lib64/libllama.so* /usr/lib64/libllama-common.so* /usr/lib64/libllama-server-impl.so \
  /usr/lib64/libggml*.so* /usr/lib64/libmtmd*.so* /usr/lib64/
RUN ldconfig

EXPOSE 8080
ENTRYPOINT ["/usr/bin/llama-server"]
