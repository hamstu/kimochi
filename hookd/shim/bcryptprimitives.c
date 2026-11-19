/*
 * A stand-in bcryptprimitives.dll for Wine 8.13 and older, which have none.
 *
 * Rust programs import ProcessPrng from bcryptprimitives.dll (Rust 1.78 and later), so the hook
 * helper and the voice hook would not load at all on such a Wine. Kimochi's Linux builds ship
 * this beside each helper. A Wine that has its own bcryptprimitives.dll (8.14 and later, Proton 8
 * and later) loads that instead: Wine prefers its builtin DLLs to a native one in the program's
 * folder. The helper loads this into a game first only when the system has none
 * (hookd/src/inject.rs).
 *
 * ProcessPrng fills the buffer with random bytes and never fails; RtlGenRandom
 * (advapi32!SystemFunction036), which every Wine has, is what Rust used before.
 */
#include <windows.h>

BOOLEAN WINAPI SystemFunction036(PVOID buffer, ULONG length);

BOOL WINAPI ProcessPrng(PBYTE data, SIZE_T length)
{
    while (length) {
        ULONG chunk = length > 0x10000000 ? 0x10000000 : (ULONG)length;
        if (!SystemFunction036(data, chunk))
            return FALSE;
        data += chunk;
        length -= chunk;
    }
    return TRUE;
}
