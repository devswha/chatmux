#!/usr/bin/env python3

import dbus
import dbus.service
from gi.repository import GLib
from dbus.mainloop.glib import DBusGMainLoop

DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
source = bus.get_object("com.openai.Codex.WindowControl", "/com/openai/Codex/WindowControl")
source_api = dbus.Interface(source, "com.openai.Codex.WindowControl")
name = dbus.service.BusName("dev.avifenesh.ComputerUseLinux.WindowControl", bus)


class Bridge(dbus.service.Object):
    @dbus.service.method("dev.avifenesh.ComputerUseLinux.WindowControl", out_signature="s")
    def ListWindows(self):
        return source_api.ListWindows()

    @dbus.service.method(
        "dev.avifenesh.ComputerUseLinux.WindowControl",
        in_signature="t",
        out_signature="bs",
    )
    def ActivateWindow(self, window_id):
        return source_api.ActivateWindow(window_id)


Bridge(name, "/dev/avifenesh/ComputerUseLinux/WindowControl")
print("WINDOW_CONTROL_BRIDGE_READY", flush=True)
GLib.MainLoop().run()
