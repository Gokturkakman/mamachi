import Carbon
import Foundation

final class GlobalHotKey {
    private var hotKey: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private let action: () -> Void

    init(action: @escaping () -> Void) throws {
        self.action = action
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let handlerStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, context in
                guard let context else { return noErr }
                let owner = Unmanaged<GlobalHotKey>.fromOpaque(context).takeUnretainedValue()
                DispatchQueue.main.async { owner.action() }
                return noErr
            },
            1,
            &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            &eventHandler
        )
        guard handlerStatus == noErr else { throw HotKeyError.registrationFailed(handlerStatus) }

        let identifier = EventHotKeyID(signature: 0x4D_41_4D_41, id: 1)
        let registrationStatus = RegisterEventHotKey(
            UInt32(kVK_Space),
            UInt32(cmdKey | shiftKey),
            identifier,
            GetApplicationEventTarget(),
            0,
            &hotKey
        )
        guard registrationStatus == noErr else {
            if let eventHandler { RemoveEventHandler(eventHandler) }
            throw HotKeyError.registrationFailed(registrationStatus)
        }
    }

    deinit {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
    }
}

enum HotKeyError: LocalizedError {
    case registrationFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .registrationFailed(let status):
            "The ⌘⇧Space hotkey could not be registered (OSStatus \(status))."
        }
    }
}
