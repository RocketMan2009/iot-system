# PlatformIO post-build script: create a single merged.bin (flash at 0x0)
# so the web flasher only needs one file.
Import("env")  # noqa: F821  (provided by PlatformIO/SCons)
import os


def merge_bin(source, target, env):
    build_dir = env.subst("$BUILD_DIR")
    out = os.path.join(build_dir, "merged.bin")
    app = os.path.join(build_dir, env.subst("${PROGNAME}.bin"))

    # FLASH_EXTRA_IMAGES = [(offset, path), ...] -> bootloader, partitions, boot_app0
    images = []
    for offset, path in env.get("FLASH_EXTRA_IMAGES", []):
        images += [offset, env.subst(path)]
    images += [env.subst("$ESP32_APP_OFFSET") or "0x10000", app]

    cmd = " ".join([
        '"$PYTHONEXE"', '"$OBJCOPY"',  # $OBJCOPY == esptool.py for espressif32
        "--chip", "esp32", "merge_bin",
        "--flash_mode", "dio", "--flash_freq", "40m", "--flash_size", "4MB",
        "-o", f'"{out}"',
    ] + [f'"{x}"' if not str(x).startswith("0x") else str(x) for x in images])
    env.Execute(cmd)
    print(f"[merge_bin] -> {out}  (flash at 0x0)")


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", merge_bin)  # noqa: F821
