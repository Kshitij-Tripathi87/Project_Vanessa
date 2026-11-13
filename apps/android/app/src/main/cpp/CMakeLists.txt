cmake_minimum_required(VERSION 3.22.1)
project(vanessa_inference LANGUAGES C CXX)

# AGP sets CMAKE_SYSTEM_VERSION to the APK's minSdk (26). Override the
# compiler/linker target for every native target, including llama.cpp.
add_compile_options("--target=aarch64-linux-android28")
add_link_options("--target=aarch64-linux-android28")

if(NOT ANDROID OR NOT ANDROID_ABI STREQUAL "arm64-v8a")
    message(FATAL_ERROR "Vanessa local inference requires Android arm64-v8a")
endif()

if(NOT LLAMA_CPP_DIR OR NOT EXISTS "${LLAMA_CPP_DIR}/include/llama.h")
    message(FATAL_ERROR "Pass -PllamaCppDir=<llama.cpp source checkout> to Gradle")
endif()

set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE OFF CACHE BOOL "" FORCE)
add_subdirectory("${LLAMA_CPP_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/llama-cpp")

add_library(vanessa_llama SHARED inference.cpp)
target_compile_features(vanessa_llama PRIVATE cxx_std_17)
target_include_directories(vanessa_llama PRIVATE "${LLAMA_CPP_DIR}/include")
target_link_libraries(vanessa_llama PRIVATE llama log)
