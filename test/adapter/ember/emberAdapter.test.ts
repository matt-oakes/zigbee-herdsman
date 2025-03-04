import path from 'path';
import {existsSync, mkdirSync, unlinkSync, writeFileSync} from 'fs';
import {EventEmitter} from 'stream';

import * as Zcl from '../../../src/zspec/zcl';
import * as Zdo from '../../../src/zspec/zdo';
import * as ZdoTypes from '../../../src/zspec/zdo/definition/tstypes';
import * as ZSpec from '../../../src/zspec';
import {TsType} from '../../../src/adapter';
import {Ezsp, EzspEvents} from '../../../src/adapter/ember/ezsp/ezsp';
import {EmberAdapter} from '../../../src/adapter/ember/adapter';
import {AdapterOptions, NetworkOptions, SerialPortOptions} from '../../../src/adapter/tstype';
import {DEFAULT_APS_OPTIONS, DEFAULT_STACK_CONFIG, LinkKeyBackupData, NetworkCache} from '../../../src/adapter/ember/adapter/emberAdapter';
import {
    EmberApsOption,
    EmberDeviceUpdate,
    EmberIncomingMessageType,
    EmberJoinDecision,
    EmberKeyStructBitmask,
    EmberNetworkStatus,
    EmberNodeType,
    EmberOutgoingMessageType,
    EmberVersionType,
    EzspStatus,
    SecManDerivedKeyType,
    SecManFlag,
    SecManKeyType,
    SLStatus,
} from '../../../src/adapter/ember/enums';
import {
    EmberAesMmoHashContext,
    EmberApsFrame,
    EmberMulticastTableEntry,
    EmberNetworkInitStruct,
    EmberNetworkParameters,
    EmberVersion,
    SecManAPSKeyMetadata,
    SecManContext,
    SecManKey,
    SecManNetworkKeyInfo,
} from '../../../src/adapter/ember/types';
import {EzspEndpointFlag, EzspConfigId, EzspValueId, EzspPolicyId, EzspDecisionBitmask} from '../../../src/adapter/ember/ezsp/enums';
import {EZSP_MIN_PROTOCOL_VERSION, EZSP_PROTOCOL_VERSION, EZSP_STACK_TYPE_MESH} from '../../../src/adapter/ember/ezsp/consts';
import {FIXED_ENDPOINTS} from '../../../src/adapter/ember/adapter/endpoints';
import {EMBER_LOW_RAM_CONCENTRATOR, INVALID_RADIO_CHANNEL, SECURITY_LEVEL_Z3} from '../../../src/adapter/ember/consts';
import {lowHighBytes} from '../../../src/adapter/ember/utils/math';
import {logger} from '../../../src/utils/logger';
import {UnifiedBackupStorage} from '../../../src/models/backup-storage-unified';
import {DeviceAnnouncePayload, DeviceJoinedPayload, DeviceLeavePayload, Events, NetworkAddressPayload, ZclPayload} from '../../../src/adapter/events';
import {EUI64, NodeId, PanId} from '../../../src/zspec/tstypes';
import {OneWaitressEvents} from '../../../src/adapter/ember/adapter/oneWaitress';
import {Backup} from '../../../src/models/backup';
import {EzspError} from '../../../src/adapter/ember/ezspError';

// https://github.com/jestjs/jest/issues/6028#issuecomment-567669082
function defuseRejection<T>(promise: Promise<T>) {
    promise.catch(() => {});

    return promise;
}

function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
}

function reverseApsFrame(apsFrame: EmberApsFrame): EmberApsFrame {
    return Object.assign({}, apsFrame, {sourceEndpoint: apsFrame.destinationEndpoint, destinationEndpoint: apsFrame.sourceEndpoint});
}

function flushPromises(): Promise<void> {
    return new Promise(jest.requireActual('timers').setImmediate);
}

const TEMP_PATH = path.resolve('temp');
const STACK_CONFIG_PATH = path.join(TEMP_PATH, 'stack_config.json');
const DEFAULT_NETWORK_OPTIONS: Readonly<NetworkOptions> = {
    panID: 24404,
    extendedPanID: [118, 185, 136, 236, 199, 244, 246, 85],
    channelList: [20],
    networkKey: [72, 97, 39, 230, 92, 72, 101, 148, 64, 225, 250, 214, 195, 31, 105, 71],
    networkKeyDistribute: false,
};
const DEFAULT_SERIAL_PORT_OPTIONS: Readonly<SerialPortOptions> = {
    baudRate: 115200,
    rtscts: false,
    path: 'MOCK',
    adapter: 'ember',
};
const DEFAULT_ADAPTER_OPTIONS: Readonly<AdapterOptions> = {
    concurrent: 16,
    disableLED: false,
};
const DEFAULT_BACKUP: Readonly<UnifiedBackupStorage> = {
    metadata: {
        format: 'zigpy/open-coordinator-backup',
        version: 1,
        source: 'zigbee-herdsman@0.55.0',
        internal: {
            date: '2024-07-19T15:57:15.163Z',
            ezspVersion: 13,
        },
    },
    stack_specific: {
        ezsp: {
            hashed_tclk: 'da85e5bac80c8a958b14d44f14c2ba16',
        },
    },
    coordinator_ieee: '1122334455667788',
    pan_id: '5f54',
    extended_pan_id: '76b988ecc7f4f655',
    nwk_update_id: 0,
    security_level: 5,
    channel: 20,
    channel_mask: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
    network_key: {
        key: '486127e65c48659440e1fad6c31f6947',
        sequence_number: 0,
        frame_counter: 16434,
    },
    devices: [],
};
const DEFAULT_COORDINATOR_IEEE: EUI64 = `0x${Buffer.from(DEFAULT_BACKUP.coordinator_ieee, 'hex').reverse().toString('hex')}`;
const DEFAULT_ADAPTER_NETWORK_PARAMETERS: EmberNetworkParameters = {
    extendedPanId: DEFAULT_NETWORK_OPTIONS.extendedPanID!,
    panId: DEFAULT_NETWORK_OPTIONS.panID,
    radioTxPower: 5,
    radioChannel: DEFAULT_NETWORK_OPTIONS.channelList[0],
    joinMethod: 0,
    nwkManagerId: 0,
    nwkUpdateId: 0,
    channels: ZSpec.ALL_802_15_4_CHANNELS_MASK,
};

let mockManufCode = Zcl.ManufacturerCode.SILICON_LABORATORIES;
let mockAPSSequence = -1; // start at 0
let mockMessageTag = -1; // start at 0
let mockEzspEmitter = new EventEmitter();
const mockEzspRemoveAllListeners = jest.fn().mockImplementation((e) => {
    mockEzspEmitter.removeAllListeners(e);
});
const mockEzspOn = jest.fn().mockImplementation((e, l) => {
    mockEzspEmitter.on(e, l);
});
const mockEzspOnce = jest.fn().mockImplementation((e, l) => {
    mockEzspEmitter.once(e, l);
});
const mockEzspStart = jest.fn().mockResolvedValue(EzspStatus.SUCCESS);
const mockEzspStop = jest.fn();

const mockEzspSend = jest.fn().mockResolvedValue([SLStatus.OK, ++mockMessageTag]);
const mockEzspSetMulticastTableEntry = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspSetManufacturerCode = jest.fn().mockImplementation((code) => (mockManufCode = code));
const mockEzspReadAndClearCounters = jest.fn().mockResolvedValue([1, 2, 3, 4]); // not matching EmberCounterType, but doesn't matter here
const mockEzspGetNetworkParameters = jest
    .fn()
    .mockResolvedValue([SLStatus.OK, EmberNodeType.COORDINATOR, deepClone(DEFAULT_ADAPTER_NETWORK_PARAMETERS)]);
const mockEzspNetworkState = jest.fn().mockResolvedValue(EmberNetworkStatus.JOINED_NETWORK);
const mockEzspGetEui64 = jest.fn().mockResolvedValue(DEFAULT_COORDINATOR_IEEE);
const mockEzspSetConcentrator = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspSetSourceRouteDiscoveryMode = jest.fn().mockResolvedValue(1240 /* ms */);
// not OK by default since used to detected unreged EP
const mockEzspGetEndpointFlags = jest.fn().mockResolvedValue([SLStatus.NOT_FOUND, EzspEndpointFlag.DISABLED]);
const mockEzspAddEndpoint = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspNetworkInit = jest.fn().mockImplementation((networkInitStruct: EmberNetworkInitStruct) => {
    setTimeout(async () => {
        mockEzspEmitter.emit(EzspEvents.STACK_STATUS, SLStatus.NETWORK_UP);
        await flushPromises();
    }, 300);

    return SLStatus.OK;
});
const mockEzspExportKey = jest.fn().mockImplementation((context: SecManContext) => {
    switch (context.coreKeyType) {
        case SecManKeyType.NETWORK: {
            return [SLStatus.OK, {contents: Buffer.from(DEFAULT_BACKUP.network_key.key, 'hex')} as SecManKey];
        }
        case SecManKeyType.TC_LINK: {
            return [SLStatus.OK, {contents: Buffer.from(DEFAULT_BACKUP.stack_specific!.ezsp!.hashed_tclk!, 'hex')} as SecManKey];
        }
    }
});
const mockEzspLeaveNetwork = jest.fn().mockImplementation(() => {
    setTimeout(async () => {
        mockEzspEmitter.emit(EzspEvents.STACK_STATUS, SLStatus.NETWORK_DOWN);
        await flushPromises();
    }, 300);

    return SLStatus.OK;
});
const mockEzspSetInitialSecurityState = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspSetExtendedSecurityBitmask = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspClearKeyTable = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspFormNetwork = jest.fn().mockImplementation((parameters: EmberNetworkParameters) => {
    setTimeout(async () => {
        mockEzspEmitter.emit(EzspEvents.STACK_STATUS, SLStatus.NETWORK_UP);
        await flushPromises();
    }, 300);

    return SLStatus.OK;
});
const mockEzspStartWritingStackTokens = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspGetConfigurationValue = jest.fn().mockImplementation((config: EzspConfigId) => {
    switch (config) {
        case EzspConfigId.KEY_TABLE_SIZE: {
            return [SLStatus.OK, 0];
        }
    }
});
const mockEzspExportLinkKeyByIndex = jest.fn();
const mockEzspEraseKeyTableEntry = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspImportLinkKey = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspBroadcastNextNetworkKey = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspBroadcastNetworkKeySwitch = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspStartScan = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspVersion = jest.fn().mockImplementation((version: number) => [version, EZSP_STACK_TYPE_MESH, 0]);
const mockEzspSetProtocolVersion = jest.fn();
const mockEzspGetVersionStruct = jest.fn().mockResolvedValue([
    SLStatus.OK,
    {
        build: 135,
        major: 8,
        minor: 0,
        patch: 0,
        special: 0,
        type: EmberVersionType.GA,
    } as EmberVersion,
]);
const mockEzspSetConfigurationValue = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspSetValue = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspSetPolicy = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspAesMmoHash = jest.fn().mockImplementation((context: EmberAesMmoHashContext, finalize: boolean, data: Buffer) => [
    SLStatus.OK,
    {result: data, length: data.length} as EmberAesMmoHashContext, // echo data
]);
const mockEzspPermitJoining = jest.fn().mockImplementation((duration: number) => {
    setTimeout(async () => {
        mockEzspEmitter.emit(EzspEvents.STACK_STATUS, duration > 0 ? SLStatus.ZIGBEE_NETWORK_OPENED : SLStatus.ZIGBEE_NETWORK_CLOSED);
        await flushPromises();
    }, 300);

    return SLStatus.OK;
});
const mockEzspSendBroadcast = jest.fn().mockResolvedValue([SLStatus.OK, ++mockAPSSequence]);
const mockEzspSendUnicast = jest.fn().mockResolvedValue([SLStatus.OK, ++mockAPSSequence]);
const mockEzspGetNetworkKeyInfo = jest.fn().mockResolvedValue([
    SLStatus.OK,
    {
        networkKeySet: true,
        alternateNetworkKeySet: false,
        networkKeySequenceNumber: DEFAULT_BACKUP.network_key.sequence_number,
        altNetworkKeySequenceNumber: 0,
        networkKeyFrameCounter: DEFAULT_BACKUP.network_key.frame_counter,
    } as SecManNetworkKeyInfo,
]);
const mockEzspSetRadioPower = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspImportTransientKey = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspClearTransientLinkKeys = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspSetLogicalAndRadioChannel = jest.fn().mockResolvedValue(SLStatus.OK);
const mockEzspSendRawMessage = jest.fn().mockResolvedValue(SLStatus.OK);

jest.mock('../../../src/adapter/ember/uart/ash');

jest.mock('../../../src/adapter/ember/ezsp/ezsp', () => ({
    ...jest.requireActual('../../../src/adapter/ember/ezsp/ezsp'),
    Ezsp: jest.fn().mockImplementation(() => ({
        removeAllListeners: mockEzspRemoveAllListeners,
        on: mockEzspOn,
        once: mockEzspOnce,

        // only functions called from adapter
        ash: {readAndClearCounters: jest.fn().mockReturnValue([9, 8, 7])},

        start: mockEzspStart,
        stop: mockEzspStop,
        send: mockEzspSend,
        ezspSetMulticastTableEntry: mockEzspSetMulticastTableEntry,
        ezspSetManufacturerCode: mockEzspSetManufacturerCode,
        ezspReadAndClearCounters: mockEzspReadAndClearCounters,
        ezspGetNetworkParameters: mockEzspGetNetworkParameters,
        ezspNetworkState: mockEzspNetworkState,
        ezspGetEui64: mockEzspGetEui64,
        ezspSetConcentrator: mockEzspSetConcentrator,
        ezspSetSourceRouteDiscoveryMode: mockEzspSetSourceRouteDiscoveryMode,
        ezspGetEndpointFlags: mockEzspGetEndpointFlags,
        ezspAddEndpoint: mockEzspAddEndpoint,
        ezspNetworkInit: mockEzspNetworkInit,
        ezspExportKey: mockEzspExportKey,
        ezspLeaveNetwork: mockEzspLeaveNetwork,
        ezspSetInitialSecurityState: mockEzspSetInitialSecurityState,
        ezspSetExtendedSecurityBitmask: mockEzspSetExtendedSecurityBitmask,
        ezspClearKeyTable: mockEzspClearKeyTable,
        ezspFormNetwork: mockEzspFormNetwork,
        ezspStartWritingStackTokens: mockEzspStartWritingStackTokens,
        ezspGetConfigurationValue: mockEzspGetConfigurationValue,
        ezspExportLinkKeyByIndex: mockEzspExportLinkKeyByIndex,
        ezspEraseKeyTableEntry: mockEzspEraseKeyTableEntry,
        ezspImportLinkKey: mockEzspImportLinkKey,
        ezspBroadcastNextNetworkKey: mockEzspBroadcastNextNetworkKey,
        ezspBroadcastNetworkKeySwitch: mockEzspBroadcastNetworkKeySwitch,
        ezspStartScan: mockEzspStartScan,
        ezspVersion: mockEzspVersion,
        setProtocolVersion: mockEzspSetProtocolVersion,
        ezspGetVersionStruct: mockEzspGetVersionStruct,
        ezspSetConfigurationValue: mockEzspSetConfigurationValue,
        ezspSetValue: mockEzspSetValue,
        ezspSetPolicy: mockEzspSetPolicy,
        ezspAesMmoHash: mockEzspAesMmoHash,
        ezspPermitJoining: mockEzspPermitJoining,
        ezspSendBroadcast: mockEzspSendBroadcast,
        ezspSendUnicast: mockEzspSendUnicast,
        ezspGetNetworkKeyInfo: mockEzspGetNetworkKeyInfo,
        ezspSetRadioPower: mockEzspSetRadioPower,
        ezspImportTransientKey: mockEzspImportTransientKey,
        ezspClearTransientLinkKeys: mockEzspClearTransientLinkKeys,
        ezspSetLogicalAndRadioChannel: mockEzspSetLogicalAndRadioChannel,
        ezspSendRawMessage: mockEzspSendRawMessage,
    })),
}));

const ezspMocks = [
    mockEzspRemoveAllListeners,
    mockEzspOn,
    mockEzspOnce,
    mockEzspStart,
    mockEzspStop,
    mockEzspSend,
    mockEzspSetMulticastTableEntry,
    mockEzspSetManufacturerCode,
    mockEzspReadAndClearCounters,
    mockEzspGetNetworkParameters,
    mockEzspNetworkState,
    mockEzspGetEui64,
    mockEzspSetConcentrator,
    mockEzspSetSourceRouteDiscoveryMode,
    mockEzspGetEndpointFlags,
    mockEzspAddEndpoint,
    mockEzspNetworkInit,
    mockEzspExportKey,
    mockEzspLeaveNetwork,
    mockEzspSetInitialSecurityState,
    mockEzspSetExtendedSecurityBitmask,
    mockEzspClearKeyTable,
    mockEzspFormNetwork,
    mockEzspStartWritingStackTokens,
    mockEzspGetConfigurationValue,
    mockEzspExportLinkKeyByIndex,
    mockEzspEraseKeyTableEntry,
    mockEzspImportLinkKey,
    mockEzspBroadcastNextNetworkKey,
    mockEzspBroadcastNetworkKeySwitch,
    mockEzspStartScan,
    mockEzspVersion,
    mockEzspSetProtocolVersion,
    mockEzspGetVersionStruct,
    mockEzspSetConfigurationValue,
    mockEzspSetValue,
    mockEzspSetPolicy,
    mockEzspAesMmoHash,
    mockEzspPermitJoining,
    mockEzspSendBroadcast,
    mockEzspSendUnicast,
    mockEzspGetNetworkKeyInfo,
    mockEzspSetRadioPower,
    mockEzspImportTransientKey,
    mockEzspClearTransientLinkKeys,
    mockEzspSetLogicalAndRadioChannel,
    mockEzspSendRawMessage,
];

describe('Ember Adapter Layer', () => {
    let adapter: EmberAdapter;
    let backupPath: string;
    let loggerSpies = {
        debug: jest.spyOn(logger, 'debug'),
        info: jest.spyOn(logger, 'info'),
        warning: jest.spyOn(logger, 'warning'),
        error: jest.spyOn(logger, 'error'),
    };

    const deleteCoordinatorBackup = () => {
        if (existsSync(backupPath)) {
            unlinkSync(backupPath);
        }
    };

    const deleteStackConfig = () => {
        if (existsSync(STACK_CONFIG_PATH)) {
            unlinkSync(STACK_CONFIG_PATH);
        }
    };

    const takeResetCodePath = () => {
        deleteCoordinatorBackup();
        mockEzspGetNetworkParameters.mockResolvedValueOnce([
            SLStatus.OK,
            EmberNodeType.COORDINATOR,
            {
                extendedPanId: DEFAULT_NETWORK_OPTIONS.extendedPanID!,
                panId: 1234,
                radioTxPower: 5,
                radioChannel: DEFAULT_NETWORK_OPTIONS.channelList[0],
                joinMethod: 0,
                nwkManagerId: 0,
                nwkUpdateId: 0,
                channels: ZSpec.ALL_802_15_4_CHANNELS_MASK,
            } as EmberNetworkParameters,
        ]);
    };

    const clearMocks = () => {
        for (const mock of ezspMocks) {
            mock.mockClear();
        }

        loggerSpies.debug.mockClear();
        loggerSpies.info.mockClear();
        loggerSpies.warning.mockClear();
        loggerSpies.error.mockClear();
    };

    beforeAll(async () => {
        if (!existsSync(TEMP_PATH)) {
            mkdirSync(TEMP_PATH);
        } else {
            // just in case, remove previous remnants
            deleteCoordinatorBackup();
            deleteStackConfig();
        }
    });

    afterAll(async () => {
        deleteCoordinatorBackup();
        deleteStackConfig();
    });

    beforeEach(async () => {
        jest.useFakeTimers();

        backupPath = path.join(TEMP_PATH, `ember_coordinator_backup.json`);

        writeFileSync(backupPath, JSON.stringify(DEFAULT_BACKUP, undefined, 2));

        mockManufCode = Zcl.ManufacturerCode.SILICON_LABORATORIES;
        mockAPSSequence = -1;
        mockMessageTag = -1;
        // make sure emitter is reset too
        mockEzspEmitter = new EventEmitter();

        clearMocks();
    });

    afterEach(async () => {
        jest.useRealTimers();
    });

    it('Creates default instance', () => {
        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        expect(adapter).toBeInstanceOf(EmberAdapter);
        expect(adapter.stackConfig).toStrictEqual(DEFAULT_STACK_CONFIG);
    });

    it('Loads custom stack config', () => {
        const config = {
            CONCENTRATOR_RAM_TYPE: 'low',
            CONCENTRATOR_MIN_TIME: 1,
            CONCENTRATOR_MAX_TIME: 31,
            CONCENTRATOR_ROUTE_ERROR_THRESHOLD: 5,
            CONCENTRATOR_DELIVERY_FAILURE_THRESHOLD: 2,
            CONCENTRATOR_MAX_HOPS: 5,
            MAX_END_DEVICE_CHILDREN: 16,
            TRANSIENT_DEVICE_TIMEOUT: 1000,
            END_DEVICE_POLL_TIMEOUT: 12,
            TRANSIENT_KEY_TIMEOUT_S: 500,
        };

        writeFileSync(STACK_CONFIG_PATH, JSON.stringify(config, undefined, 2));

        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        expect(adapter.stackConfig).toStrictEqual(config);

        // cleanup
        unlinkSync(STACK_CONFIG_PATH);
    });

    it('Loads only valid custom stack config', () => {
        const config = {
            CONCENTRATOR_RAM_TYPE: 'bad',
            CONCENTRATOR_MIN_TIME: -1,
            CONCENTRATOR_MAX_TIME: 15,
            CONCENTRATOR_ROUTE_ERROR_THRESHOLD: 500,
            CONCENTRATOR_DELIVERY_FAILURE_THRESHOLD: 200,
            CONCENTRATOR_MAX_HOPS: 35,
            MAX_END_DEVICE_CHILDREN: 65,
            TRANSIENT_DEVICE_TIMEOUT: 65536,
            END_DEVICE_POLL_TIMEOUT: 15,
            TRANSIENT_KEY_TIMEOUT_S: 65536,
        };

        writeFileSync(STACK_CONFIG_PATH, JSON.stringify(config, undefined, 2));

        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        expect(adapter.stackConfig).toStrictEqual(DEFAULT_STACK_CONFIG);

        // cleanup
        unlinkSync(STACK_CONFIG_PATH);
    });

    it('Uses default concurrency for queue if not supplied/valid', () => {
        adapter = new EmberAdapter(
            DEFAULT_NETWORK_OPTIONS,
            DEFAULT_SERIAL_PORT_OPTIONS,
            backupPath,
            Object.assign({}, DEFAULT_ADAPTER_OPTIONS, {concurrent: undefined}),
        );
        // @ts-expect-error private
        expect(adapter.queue.concurrent).toStrictEqual(16);
    });

    it('Starts with resumed when everything matches', async () => {
        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);
        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('resumed');
        expect(mockEzspSetProtocolVersion).toHaveBeenCalledWith(EZSP_PROTOCOL_VERSION);
        expect(
            // @ts-expect-error private
            adapter.networkCache,
        ).toStrictEqual({
            eui64: DEFAULT_COORDINATOR_IEEE,
            parameters: {
                extendedPanId: DEFAULT_NETWORK_OPTIONS.extendedPanID!,
                panId: DEFAULT_NETWORK_OPTIONS.panID,
                radioTxPower: 5,
                radioChannel: DEFAULT_NETWORK_OPTIONS.channelList[0],
                joinMethod: 0,
                nwkManagerId: 0,
                nwkUpdateId: 0,
                channels: ZSpec.ALL_802_15_4_CHANNELS_MASK,
            } as EmberNetworkParameters,
        } as NetworkCache);
    });

    it('Starts with custom stack config', async () => {
        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);
        const config = {
            CONCENTRATOR_RAM_TYPE: 'low',
            CONCENTRATOR_MIN_TIME: 1,
            CONCENTRATOR_MAX_TIME: 31,
            CONCENTRATOR_ROUTE_ERROR_THRESHOLD: 5,
            CONCENTRATOR_DELIVERY_FAILURE_THRESHOLD: 2,
            CONCENTRATOR_MAX_HOPS: 5,
            MAX_END_DEVICE_CHILDREN: 16,
            TRANSIENT_DEVICE_TIMEOUT: 1000,
            END_DEVICE_POLL_TIMEOUT: 12,
            TRANSIENT_KEY_TIMEOUT_S: 500,
        };

        writeFileSync(STACK_CONFIG_PATH, JSON.stringify(config, undefined, 2));

        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);
        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('resumed');
        expect(mockEzspSetValue).toHaveBeenCalledWith(EzspValueId.TRANSIENT_DEVICE_TIMEOUT, 2, lowHighBytes(config.TRANSIENT_DEVICE_TIMEOUT));
        expect(mockEzspSetConfigurationValue).toHaveBeenCalledWith(EzspConfigId.MAX_END_DEVICE_CHILDREN, config.MAX_END_DEVICE_CHILDREN);
        expect(mockEzspSetConfigurationValue).toHaveBeenCalledWith(EzspConfigId.END_DEVICE_POLL_TIMEOUT, config.END_DEVICE_POLL_TIMEOUT);
        expect(mockEzspSetConfigurationValue).toHaveBeenCalledWith(EzspConfigId.TRANSIENT_KEY_TIMEOUT_S, config.TRANSIENT_KEY_TIMEOUT_S);
        expect(mockEzspSetConcentrator).toHaveBeenCalledWith(
            true,
            EMBER_LOW_RAM_CONCENTRATOR,
            config.CONCENTRATOR_MIN_TIME,
            config.CONCENTRATOR_MAX_TIME,
            config.CONCENTRATOR_ROUTE_ERROR_THRESHOLD,
            config.CONCENTRATOR_DELIVERY_FAILURE_THRESHOLD,
            config.CONCENTRATOR_MAX_HOPS,
        );

        // cleanup
        unlinkSync(STACK_CONFIG_PATH);
    });

    it('Starts with restored when no network in adapter', async () => {
        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        mockEzspNetworkInit.mockResolvedValueOnce(SLStatus.NOT_JOINED);

        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('restored');
    });

    it('Starts with restored when network param mismatch but backup available', async () => {
        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        mockEzspGetNetworkParameters.mockResolvedValueOnce([
            SLStatus.OK,
            EmberNodeType.COORDINATOR,
            {
                extendedPanId: DEFAULT_NETWORK_OPTIONS.extendedPanID!,
                panId: 1234,
                radioTxPower: 5,
                radioChannel: DEFAULT_NETWORK_OPTIONS.channelList[0],
                joinMethod: 0,
                nwkManagerId: 0,
                nwkUpdateId: 0,
                channels: ZSpec.ALL_802_15_4_CHANNELS_MASK,
            } as EmberNetworkParameters,
        ]);

        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('restored');
    });

    it('Starts with restored when network key mismatch but backup available', async () => {
        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        mockEzspGetNetworkParameters.mockResolvedValueOnce([
            SLStatus.OK,
            EmberNodeType.COORDINATOR,
            {
                extendedPanId: DEFAULT_NETWORK_OPTIONS.extendedPanID!,
                panId: DEFAULT_NETWORK_OPTIONS.panID,
                radioTxPower: 5,
                radioChannel: DEFAULT_NETWORK_OPTIONS.channelList[0],
                joinMethod: 0,
                nwkManagerId: 0,
                nwkUpdateId: 0,
                channels: ZSpec.ALL_802_15_4_CHANNELS_MASK,
            } as EmberNetworkParameters,
        ]);
        const contents = Buffer.from(DEFAULT_BACKUP.network_key.key, 'hex').fill(0xff);
        mockEzspExportKey.mockResolvedValueOnce([SLStatus.OK, {contents} as SecManKey]);

        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('restored');
    });

    it('Starts with reset when networks mismatch but no backup available', async () => {
        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        deleteCoordinatorBackup();
        mockEzspGetNetworkParameters.mockResolvedValueOnce([
            SLStatus.OK,
            EmberNodeType.COORDINATOR,
            {
                extendedPanId: DEFAULT_NETWORK_OPTIONS.extendedPanID!,
                panId: 1234,
                radioTxPower: 5,
                radioChannel: DEFAULT_NETWORK_OPTIONS.channelList[0],
                joinMethod: 0,
                nwkManagerId: 0,
                nwkUpdateId: 0,
                channels: ZSpec.ALL_802_15_4_CHANNELS_MASK,
            } as EmberNetworkParameters,
        ]);

        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('reset');
    });

    it('Starts with reset when backup/config mismatch', async () => {
        adapter = new EmberAdapter(
            Object.assign({}, DEFAULT_NETWORK_OPTIONS, {panID: 1234}),
            DEFAULT_SERIAL_PORT_OPTIONS,
            backupPath,
            DEFAULT_ADAPTER_OPTIONS,
        );

        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('reset');
    });

    it('Fails to start when EZSP layer fails to start', async () => {
        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        mockEzspStart.mockResolvedValueOnce(EzspStatus.HOST_FATAL_ERROR);

        const result = adapter.start();

        await expect(result).rejects.toThrow(`Failed to start EZSP layer with status=${EzspStatus[EzspStatus.HOST_FATAL_ERROR]}.`);
    });

    it.each([
        [
            'if NCP has improper stack type',
            () => {
                mockEzspVersion.mockResolvedValueOnce([14, 1, 123]);
            },
            `Stack type 1 is not expected!`,
        ],
        [
            'if NCP version unsupported',
            () => {
                mockEzspVersion.mockResolvedValueOnce([12, EZSP_STACK_TYPE_MESH, 123]);
            },
            `Adapter EZSP protocol version (12) is not supported by Host [${EZSP_MIN_PROTOCOL_VERSION}-${EZSP_PROTOCOL_VERSION}].`,
        ],
        [
            'if NCP has old style version number',
            () => {
                mockEzspGetVersionStruct.mockResolvedValueOnce([SLStatus.INVALID_PARAMETER, 0]);
            },
            `NCP has old-style version number. Not supported.`,
        ],
        [
            'if network is not valid by end of init sequence',
            () => {
                mockEzspGetNetworkParameters
                    .mockResolvedValueOnce([SLStatus.OK, EmberNodeType.COORDINATOR, deepClone(DEFAULT_ADAPTER_NETWORK_PARAMETERS)])
                    .mockResolvedValueOnce([SLStatus.FAIL, 0, {}]);
            },
            `Failed to get network parameters with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if could not set concentrator',
            () => {
                mockEzspSetConcentrator.mockResolvedValueOnce(SLStatus.FAIL);
            },
            `[CONCENTRATOR] Failed to set concentrator with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if could not add endpoint',
            () => {
                mockEzspAddEndpoint.mockResolvedValueOnce(SLStatus.FAIL);
            },
            `Failed to register endpoint '1' with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if could not set multicast table entry',
            () => {
                mockEzspSetMulticastTableEntry.mockResolvedValueOnce(SLStatus.FAIL);
            },
            `Failed to register group '0' in multicast table with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if could not set TC key request policy',
            () => {
                mockEzspSetPolicy
                    .mockResolvedValueOnce(SLStatus.OK) // EzspPolicyId.BINDING_MODIFICATION_POLICY
                    .mockResolvedValueOnce(SLStatus.OK) // EzspPolicyId.MESSAGE_CONTENTS_IN_CALLBACK_POLICY
                    .mockResolvedValueOnce(SLStatus.FAIL); // EzspPolicyId.TC_KEY_REQUEST_POLICY
            },
            `[INIT TC] Failed to set EzspPolicyId TC_KEY_REQUEST_POLICY to ALLOW_TC_KEY_REQUESTS_AND_SEND_CURRENT_KEY with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if could not set app key request policy',
            () => {
                mockEzspSetPolicy
                    .mockResolvedValueOnce(SLStatus.OK) // EzspPolicyId.BINDING_MODIFICATION_POLICY
                    .mockResolvedValueOnce(SLStatus.OK) // EzspPolicyId.MESSAGE_CONTENTS_IN_CALLBACK_POLICY
                    .mockResolvedValueOnce(SLStatus.OK) // EzspPolicyId.TC_KEY_REQUEST_POLICY
                    .mockResolvedValueOnce(SLStatus.FAIL); // EzspPolicyId.APP_KEY_REQUEST_POLICY
            },
            `[INIT TC] Failed to set EzspPolicyId APP_KEY_REQUEST_POLICY to DENY_APP_KEY_REQUESTS with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if could not set app key request policy',
            () => {
                mockEzspSetPolicy
                    .mockResolvedValueOnce(SLStatus.OK) // EzspPolicyId.BINDING_MODIFICATION_POLICY
                    .mockResolvedValueOnce(SLStatus.OK) // EzspPolicyId.MESSAGE_CONTENTS_IN_CALLBACK_POLICY
                    .mockResolvedValueOnce(SLStatus.OK) // EzspPolicyId.TC_KEY_REQUEST_POLICY
                    .mockResolvedValueOnce(SLStatus.OK) // EzspPolicyId.APP_KEY_REQUEST_POLICY
                    .mockResolvedValueOnce(SLStatus.FAIL); // EzspPolicyId.TRUST_CENTER_POLICY
            },
            `[INIT TC] Failed to set join policy to USE_PRECONFIGURED_KEY with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if could not init network',
            () => {
                mockEzspNetworkInit.mockResolvedValueOnce(SLStatus.FAIL);
            },
            `[INIT TC] Failed network init request with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if could not export network key',
            () => {
                mockEzspExportKey.mockResolvedValueOnce([SLStatus.FAIL, Buffer.alloc(16)]);
            },
            `[INIT TC] Failed to export Network Key with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if could not leave network',
            () => {
                // force leave code path
                mockEzspGetNetworkParameters.mockResolvedValueOnce([SLStatus.FAIL, 0, {}]);
                mockEzspLeaveNetwork.mockResolvedValueOnce(SLStatus.FAIL);
            },
            `[INIT TC] Failed leave network request with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if form could not set initial security state',
            () => {
                takeResetCodePath();
                mockEzspSetInitialSecurityState.mockResolvedValueOnce(SLStatus.FAIL);
            },
            `[INIT FORM] Failed to set initial security state with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if form could not set extended security bitmask',
            () => {
                takeResetCodePath();
                mockEzspSetExtendedSecurityBitmask.mockResolvedValueOnce(SLStatus.FAIL);
            },
            `[INIT FORM] Failed to set extended security bitmask to 272 with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if could not form network',
            () => {
                takeResetCodePath();
                mockEzspFormNetwork.mockResolvedValueOnce(SLStatus.FAIL);
            },
            `[INIT FORM] Failed form network request with status=${SLStatus[SLStatus.FAIL]}.`,
        ],
        [
            'if backup corrupted',
            () => {
                writeFileSync(backupPath, 'abcd');
            },
            `[BACKUP] Coordinator backup is corrupted.`,
        ],
        [
            'if backup unsupported',
            () => {
                const customBackup = deepClone(DEFAULT_BACKUP);
                // @ts-expect-error mock override
                customBackup.metadata.version = 2;

                writeFileSync(backupPath, JSON.stringify(customBackup, undefined, 2));
            },
            `[BACKUP] Unsupported open coordinator backup version (version=2).`,
        ],
        [
            'if backup not EmberZNet stack specific',
            () => {
                const customBackup = deepClone(DEFAULT_BACKUP);
                customBackup.stack_specific!.ezsp = undefined;

                writeFileSync(backupPath, JSON.stringify(customBackup, undefined, 2));
            },
            `[BACKUP] Current backup file is not for EmberZNet stack.`,
        ],
        [
            'if backup not EmberZNet EZSP version',
            () => {
                const customBackup = deepClone(DEFAULT_BACKUP);
                customBackup.metadata.internal.ezspVersion = undefined;

                writeFileSync(backupPath, JSON.stringify(customBackup, undefined, 2));
            },
            `[BACKUP] Current backup file is not for EmberZNet stack.`,
        ],
        [
            'if backup unknown format',
            () => {
                const customBackup = deepClone(DEFAULT_BACKUP);
                // @ts-expect-error mock override
                customBackup.metadata.format = 'unknown';

                writeFileSync(backupPath, JSON.stringify(customBackup, undefined, 2));
            },
            `[BACKUP] Unknown backup format.`,
        ],
    ])('Fails to start %s', async (_reason, setup, error) => {
        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        setup();

        const result = defuseRejection(adapter.start());

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).rejects.toThrow(error);
    });

    it('Warns if NCP has non-GA firmware', async () => {
        const type: EmberVersionType = EmberVersionType.ALPHA_1;

        mockEzspGetVersionStruct.mockResolvedValueOnce([
            SLStatus.OK,
            {
                build: 135,
                major: 8,
                minor: 0,
                patch: 0,
                special: 0,
                type,
            } as EmberVersion,
        ]);

        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('resumed');

        expect(loggerSpies.warning).toHaveBeenCalledWith(`Adapter is running a non-GA version (${EmberVersionType[type]}).`, 'zh:ember');
    });

    it('Switches EZSP protocol when supported', async () => {
        mockEzspVersion.mockResolvedValueOnce([EZSP_MIN_PROTOCOL_VERSION, EZSP_STACK_TYPE_MESH, 123]);

        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('resumed');
        expect(mockEzspVersion).toHaveBeenNthCalledWith(1, EZSP_PROTOCOL_VERSION);
        expect(mockEzspVersion).toHaveBeenNthCalledWith(2, EZSP_MIN_PROTOCOL_VERSION);
        expect(mockEzspSetProtocolVersion).toHaveBeenCalledWith(EZSP_MIN_PROTOCOL_VERSION);
    });

    it('Logs failed set config value on start', async () => {
        mockEzspSetConfigurationValue.mockResolvedValueOnce(SLStatus.ALLOCATION_FAILED);

        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('resumed');

        expect(loggerSpies.info).toHaveBeenCalledWith(
            `[EzspConfigId] Failed to SET '${EzspConfigId[EzspConfigId.TRUST_CENTER_ADDRESS_CACHE_SIZE]}' TO '2' with status=${SLStatus[SLStatus.ALLOCATION_FAILED]}. Firmware value will be used instead.`,
            'zh:ember',
        );
    });

    it('Starts and skips adding endpoint if already present', async () => {
        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

        mockEzspGetEndpointFlags
            .mockResolvedValueOnce([SLStatus.NOT_FOUND, EzspEndpointFlag.DISABLED])
            .mockResolvedValueOnce([SLStatus.OK, EzspEndpointFlag.ENABLED]); // mock GP already registered

        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('resumed');
        expect(mockEzspAddEndpoint).toHaveBeenCalledTimes(1);
        const ep = FIXED_ENDPOINTS[0];
        expect(mockEzspAddEndpoint).toHaveBeenCalledWith(
            ep.endpoint,
            ep.profileId,
            ep.deviceId,
            ep.deviceVersion,
            ep.inClusterList.slice(), // copy
            ep.outClusterList.slice(), // copy
        );
    });

    it('Starts and detects when network key frame counter will soon wrap to 0', async () => {
        const customBackup = deepClone(DEFAULT_BACKUP);
        customBackup.network_key.frame_counter = 0xfeeeeeef;

        writeFileSync(backupPath, JSON.stringify(customBackup, undefined, 2));

        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);
        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('resumed');
        expect(logger.warning).toHaveBeenCalledWith(
            `[INIT TC] Network key frame counter is reaching its limit. A new network key will have to be instaured soon.`,
            'zh:ember',
        );
    });

    it('Starts and soft-fails if unable to clear key table', async () => {
        takeResetCodePath();
        mockEzspClearKeyTable.mockResolvedValueOnce(SLStatus.FAIL);

        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);
        const result = adapter.start();

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('reset');
        expect(loggerSpies.error).toHaveBeenCalledWith(`[INIT FORM] Failed to clear key table with status=${SLStatus[SLStatus.FAIL]}.`, 'zh:ember');
    });

    it('Starts but ignores backup if unsupported version', async () => {
        const customBackup = deepClone(DEFAULT_BACKUP);
        customBackup.metadata.internal.ezspVersion = 11;

        writeFileSync(backupPath, JSON.stringify(customBackup, undefined, 2));

        adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);
        const result = adapter.start();
        const old = `${backupPath}.old`;

        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toStrictEqual('resumed');
        expect(existsSync(old)).toBeTruthy();
        expect(loggerSpies.warning).toHaveBeenCalledWith(
            `[BACKUP] Current backup file is from an unsupported EZSP version. Renaming and ignoring.`,
            'zh:ember',
        );

        // cleanup
        unlinkSync(old);
    });

    describe('When started', () => {
        beforeEach(async () => {
            adapter = new EmberAdapter(DEFAULT_NETWORK_OPTIONS, DEFAULT_SERIAL_PORT_OPTIONS, backupPath, DEFAULT_ADAPTER_OPTIONS);

            const result = adapter.start();

            await jest.advanceTimersByTimeAsync(5000);
            await result;

            // clean slate "post-start"
            clearMocks();
        });

        it('Retrieves parameters from cache when cache valid', async () => {
            await expect(adapter.emberGetEui64()).resolves.toStrictEqual(DEFAULT_COORDINATOR_IEEE);
            expect(mockEzspGetEui64).toHaveBeenCalledTimes(0);

            await expect(adapter.emberGetPanId()).resolves.toStrictEqual(DEFAULT_NETWORK_OPTIONS.panID);
            expect(mockEzspGetNetworkParameters).toHaveBeenCalledTimes(0);

            await expect(adapter.emberGetExtendedPanId()).resolves.toStrictEqual(DEFAULT_NETWORK_OPTIONS.extendedPanID!);
            expect(mockEzspGetNetworkParameters).toHaveBeenCalledTimes(0);

            await expect(adapter.emberGetRadioChannel()).resolves.toStrictEqual(DEFAULT_NETWORK_OPTIONS.channelList[0]);
            expect(mockEzspGetNetworkParameters).toHaveBeenCalledTimes(0);
        });

        it('Retrieves parameters from NCP when cache invalid', async () => {
            adapter.clearNetworkCache();
            await expect(adapter.emberGetEui64()).resolves.toStrictEqual(DEFAULT_COORDINATOR_IEEE);
            expect(mockEzspGetEui64).toHaveBeenCalledTimes(1);

            adapter.clearNetworkCache();
            await expect(adapter.emberGetPanId()).resolves.toStrictEqual(DEFAULT_NETWORK_OPTIONS.panID);
            expect(mockEzspGetNetworkParameters).toHaveBeenCalledTimes(1);

            adapter.clearNetworkCache();
            await expect(adapter.emberGetExtendedPanId()).resolves.toStrictEqual(DEFAULT_NETWORK_OPTIONS.extendedPanID!);
            expect(mockEzspGetNetworkParameters).toHaveBeenCalledTimes(2);

            adapter.clearNetworkCache();
            await expect(adapter.emberGetRadioChannel()).resolves.toStrictEqual(DEFAULT_NETWORK_OPTIONS.channelList[0]);
            expect(mockEzspGetNetworkParameters).toHaveBeenCalledTimes(3);
        });

        it('Throws when failed to retrieve parameter from NCP', async () => {
            mockEzspGetNetworkParameters
                .mockResolvedValueOnce([SLStatus.FAIL, 0, {}])
                .mockResolvedValueOnce([SLStatus.FAIL, 0, {}])
                .mockResolvedValueOnce([SLStatus.FAIL, 0, {}]);

            adapter.clearNetworkCache();

            const p1 = defuseRejection(adapter.emberGetPanId());

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p1).rejects.toThrow(`Failed to get PAN ID (via network parameters) with status=${SLStatus[SLStatus.FAIL]}.`);

            adapter.clearNetworkCache();

            const p2 = defuseRejection(adapter.emberGetExtendedPanId());

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p2).rejects.toThrow(`Failed to get Extended PAN ID (via network parameters) with status=${SLStatus[SLStatus.FAIL]}.`);

            adapter.clearNetworkCache();

            const p3 = defuseRejection(adapter.emberGetRadioChannel());

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p3).rejects.toThrow(`Failed to get radio channel (via network parameters) with status=${SLStatus[SLStatus.FAIL]}.`);
        });

        it('Logs stack status change', async () => {
            mockEzspEmitter.emit(EzspEvents.STACK_STATUS, SLStatus.ZIGBEE_TRUST_CENTER_SWAP_EUI_HAS_CHANGED);
            await flushPromises();

            expect(loggerSpies.debug).toHaveBeenCalledWith(
                `[STACK STATUS] ${SLStatus[SLStatus.ZIGBEE_TRUST_CENTER_SWAP_EUI_HAS_CHANGED]}.`,
                'zh:ember',
            );
        });

        it('Handles message delivery failure', async () => {
            let apsFrame: EmberApsFrame = {
                profileId: ZSpec.HA_PROFILE_ID,
                clusterId: Zcl.Clusters.genBasic.ID,
                sourceEndpoint: 1,
                destinationEndpoint: 1,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspEmitter.emit(EzspEvents.MESSAGE_SENT, SLStatus.ZIGBEE_DELIVERY_FAILED, EmberOutgoingMessageType.BROADCAST, 1234, apsFrame, 1);
            await flushPromises();

            expect(loggerSpies.error).toHaveBeenCalledWith(
                `Delivery of BROADCAST failed for '1234' [apsFrame=${JSON.stringify(apsFrame)} messageTag=1]`,
                'zh:ember',
            );

            const spyDeliveryFailedFor = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'deliveryFailedFor',
            );

            apsFrame = {
                profileId: ZSpec.HA_PROFILE_ID,
                clusterId: Zcl.Clusters.genBasic.ID,
                sourceEndpoint: 1,
                destinationEndpoint: 1,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspEmitter.emit(EzspEvents.MESSAGE_SENT, SLStatus.ZIGBEE_DELIVERY_FAILED, EmberOutgoingMessageType.DIRECT, 1234, apsFrame, 1);
            await flushPromises();

            expect(spyDeliveryFailedFor).toHaveBeenCalledTimes(1);
            expect(spyDeliveryFailedFor).toHaveBeenCalledWith(1234, apsFrame);
        });

        it('Registers message unknown group in multicast table', async () => {
            // @ts-expect-error private
            const tableIdx = adapter.multicastTable.length;
            const apsFrame = {
                profileId: ZSpec.HA_PROFILE_ID,
                clusterId: Zcl.Clusters.genBasic.ID,
                sourceEndpoint: 1,
                destinationEndpoint: 0xff,
                options: 0,
                groupId: 123,
                sequence: 0,
            };

            mockEzspEmitter.emit(EzspEvents.MESSAGE_SENT, SLStatus.OK, EmberOutgoingMessageType.MULTICAST, 1234, apsFrame, 1);
            await flushPromises();

            expect(mockEzspSetMulticastTableEntry).toHaveBeenCalledTimes(1);
            expect(mockEzspSetMulticastTableEntry).toHaveBeenCalledWith(tableIdx, {
                multicastId: 123,
                endpoint: FIXED_ENDPOINTS[0].endpoint,
                networkIndex: FIXED_ENDPOINTS[0].networkIndex,
            } as EmberMulticastTableEntry);
            expect(
                // @ts-expect-error private
                adapter.multicastTable.length,
            ).toStrictEqual(tableIdx + 1);
        });

        it('Fails to register message unknown group in multicast table', async () => {
            mockEzspSetMulticastTableEntry.mockResolvedValueOnce(SLStatus.FAIL);

            // @ts-expect-error private
            const tableIdx = adapter.multicastTable.length;
            const apsFrame = {
                profileId: ZSpec.HA_PROFILE_ID,
                clusterId: Zcl.Clusters.genBasic.ID,
                sourceEndpoint: 1,
                destinationEndpoint: 0xff,
                options: 0,
                groupId: 123,
                sequence: 0,
            };

            mockEzspEmitter.emit(EzspEvents.MESSAGE_SENT, SLStatus.OK, EmberOutgoingMessageType.MULTICAST, 1234, apsFrame, 1);
            await flushPromises();

            expect(mockEzspSetMulticastTableEntry).toHaveBeenCalledTimes(1);
            expect(mockEzspSetMulticastTableEntry).toHaveBeenCalledWith(tableIdx, {
                multicastId: 123,
                endpoint: FIXED_ENDPOINTS[0].endpoint,
                networkIndex: FIXED_ENDPOINTS[0].networkIndex,
            } as EmberMulticastTableEntry);
            expect(
                // @ts-expect-error private
                adapter.multicastTable.length,
            ).toStrictEqual(tableIdx); // not increased, entry was removed
        });

        it('Emits network address event on ZDO NETWORK_ADDRESS_RESPONSE', async () => {
            const spyResolveZDO = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'resolveZDO',
            );
            const spyEmit = jest.spyOn(adapter, 'emit');
            const sender = 1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspEmitter.emit(
                EzspEvents.ZDO_RESPONSE,
                apsFrame,
                sender,
                Buffer.from([1, Zdo.Status.SUCCESS, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 0x22, 0x33, 0xd2, 0x04]),
            );
            await flushPromises();

            expect(spyResolveZDO).toHaveBeenCalledTimes(1);
            expect(spyResolveZDO).toHaveBeenCalledWith(sender, apsFrame, {
                eui64: '0x332211eeddccbbaa',
                nwkAddress: sender,
                startIndex: 0,
                assocDevList: [],
            } as ZdoTypes.NetworkAddressResponse);
            expect(spyEmit).toHaveBeenCalledWith(Events.networkAddress, {
                networkAddress: sender,
                ieeeAddr: '0x332211eeddccbbaa',
            } as NetworkAddressPayload);
        });

        it('Emits device announce event on ZDO END_DEVICE_ANNOUNCE', async () => {
            const spyResolveZDO = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'resolveZDO',
            );
            const spyEmit = jest.spyOn(adapter, 'emit');
            const sender = 1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.END_DEVICE_ANNOUNCE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspEmitter.emit(
                EzspEvents.ZDO_RESPONSE,
                apsFrame,
                sender,
                Buffer.from([1, 0xd2, 0x04, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 0x22, 0x33, 6]),
            );

            await flushPromises();

            expect(spyResolveZDO).toHaveBeenCalledTimes(1);
            expect(spyResolveZDO).toHaveBeenCalledWith(sender, apsFrame, {
                nwkAddress: sender,
                eui64: '0x332211eeddccbbaa',
                capabilities: {
                    alternatePANCoordinator: 0,
                    deviceType: 1,
                    powerSource: 1,
                    rxOnWhenIdle: 0,
                    reserved1: 0,
                    reserved2: 0,
                    securityCapability: 0,
                    allocateAddress: 0,
                },
            } as ZdoTypes.EndDeviceAnnounce);
            expect(spyEmit).toHaveBeenCalledWith(Events.deviceAnnounce, {
                networkAddress: sender,
                ieeeAddr: '0x332211eeddccbbaa',
            } as DeviceAnnouncePayload);
        });

        it('Emits ZCL payload on incoming message', async () => {
            const spyResolveZCL = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'resolveZCL',
            );
            const spyEmit = jest.spyOn(adapter, 'emit');
            const sender = 1234;
            const apsFrame: EmberApsFrame = {
                profileId: ZSpec.HA_PROFILE_ID,
                clusterId: Zcl.Clusters.genBasic.ID,
                sourceEndpoint: 2,
                destinationEndpoint: 1,
                options: 0,
                groupId: 0,
                sequence: 0,
            };
            const lastHopLqi = 252;
            // Received Zigbee message from '0x', type 'readResponse', cluster 'genBasic', data '{"zclVersion":3}' from endpoint 1 with groupID 0
            const messageContents = Buffer.from('1803010000002003', 'hex');

            mockEzspEmitter.emit(EzspEvents.INCOMING_MESSAGE, EmberIncomingMessageType.UNICAST, apsFrame, lastHopLqi, sender, messageContents);
            await flushPromises();

            const payload: ZclPayload = {
                clusterID: apsFrame.clusterId,
                header: Zcl.Header.fromBuffer(messageContents),
                address: sender,
                data: messageContents,
                endpoint: apsFrame.sourceEndpoint,
                linkquality: lastHopLqi,
                groupID: apsFrame.groupId,
                wasBroadcast: false,
                destinationEndpoint: apsFrame.destinationEndpoint,
            };

            expect(spyResolveZCL).toHaveBeenCalledTimes(1);
            expect(spyResolveZCL).toHaveBeenCalledWith(payload);
            expect(spyEmit).toHaveBeenCalledWith(Events.zclPayload, payload);
        });

        it('Emits ZCL payload on touchlink message', async () => {
            const spyResolveZCL = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'resolveZCL',
            );
            const spyEmit = jest.spyOn(adapter, 'emit');
            const sourcePanId: PanId = 0x1234;
            const sourceAddress: EUI64 = '0x1122334455aabbcc';
            const lastHopLqi = 252;
            const groupId: number | null = null;
            const messageContents = Buffer.from('1803010000002003', 'hex');

            mockEzspEmitter.emit(EzspEvents.TOUCHLINK_MESSAGE, sourcePanId, sourceAddress, groupId, lastHopLqi, messageContents);
            await flushPromises();

            const payload: ZclPayload = {
                clusterID: Zcl.Clusters.touchlink.ID,
                header: Zcl.Header.fromBuffer(messageContents),
                address: sourceAddress,
                data: messageContents,
                endpoint: 1,
                linkquality: lastHopLqi,
                // @ts-expect-error improper typing
                groupID: groupId,
                wasBroadcast: true,
                destinationEndpoint: FIXED_ENDPOINTS[0].endpoint,
            };

            expect(spyResolveZCL).toHaveBeenCalledTimes(1);
            expect(spyResolveZCL).toHaveBeenCalledWith(payload);
            expect(spyEmit).toHaveBeenCalledWith(Events.zclPayload, payload);
        });

        it('Emits ZCL payload on greenpower message', async () => {
            const spyResolveZCL = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'resolveZCL',
            );
            const spyEmit = jest.spyOn(adapter, 'emit');
            const sourceId: number = 1234;
            const gpdLink = 123;
            const sequenceNumber: number = 1;
            const commandIdentifier: number = Zcl.Clusters.greenPower.commands.commissioningNotification.ID;
            const frameCounter: number = 102;
            const gpdCommandId: number = 0xe0;
            const gpdCommandPayload = Buffer.from([
                0x02 /* deviceID */,
                0x83 /* options */,
                0xf2 /* extendedOptions */,
                ...[0xf1, 0xec, 0x92, 0xab, 0xff, 0x8f, 0x13, 0x63, 0xe1, 0x46, 0xbe, 0xb5, 0x18, 0xc9, 0x0c, 0xab] /* securityKey */,
                0xa4,
                0x46,
                0xd4,
                0xd5 /* keyMic */,
                0xe4,
                0x04,
                0x00,
                0x00 /* outgoingCounter */,
            ]);

            mockEzspEmitter.emit(
                EzspEvents.GREENPOWER_MESSAGE,
                sequenceNumber,
                commandIdentifier,
                sourceId,
                frameCounter,
                gpdCommandId,
                gpdCommandPayload,
                gpdLink,
            );
            await flushPromises();

            const gpdHeader = Buffer.alloc(15);
            gpdHeader.writeUInt8(0b00000001, 0);
            gpdHeader.writeUInt8(sequenceNumber, 1);
            gpdHeader.writeUInt8(commandIdentifier, 2);
            gpdHeader.writeUInt16LE(0, 3);
            gpdHeader.writeUInt32LE(sourceId, 5);
            gpdHeader.writeUInt32LE(frameCounter, 9);
            gpdHeader.writeUInt8(gpdCommandId, 13);
            gpdHeader.writeUInt8(gpdCommandPayload.length, 14);

            const data = Buffer.concat([gpdHeader, gpdCommandPayload]);
            const payload: ZclPayload = {
                header: Zcl.Header.fromBuffer(data),
                data,
                clusterID: Zcl.Clusters.greenPower.ID,
                address: sourceId,
                endpoint: ZSpec.GP_ENDPOINT,
                linkquality: gpdLink,
                groupID: 0x0b84, // TODO: this should be moved out of Adapter class and into ZSpec consts
                wasBroadcast: true,
                destinationEndpoint: ZSpec.GP_ENDPOINT,
            };

            expect(spyResolveZCL).toHaveBeenCalledTimes(1);
            expect(spyResolveZCL).toHaveBeenCalledWith(payload);
            expect(spyEmit).toHaveBeenCalledWith(Events.zclPayload, payload);
        });

        it('Handles improper greenpower message', async () => {
            const spyResolveZCL = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'resolveZCL',
            );
            const spyEmit = jest.spyOn(adapter, 'emit');
            const sourceId: number = 1234;
            const gpdLink = 123;
            const sequenceNumber: number = 1;
            const commandIdentifier: number = Zcl.Clusters.greenPower.commands.commissioningNotification.ID;
            const frameCounter: number = 102;
            const gpdCommandId: number = 0xe0;
            const gpdCommandPayload = undefined;

            mockEzspEmitter.emit(
                EzspEvents.GREENPOWER_MESSAGE,
                sequenceNumber,
                commandIdentifier,
                sourceId,
                frameCounter,
                gpdCommandId,
                gpdCommandPayload,
                gpdLink,
            );
            await flushPromises();

            expect(spyResolveZCL).toHaveBeenCalledTimes(0);
            expect(spyEmit).toHaveBeenCalledTimes(0);
        });

        it('Emits device joined on trust center join', async () => {
            const spyEmit = jest.spyOn(adapter, 'emit');
            const newNodeId: NodeId = 1234;
            const newNodeEui64: EUI64 = '0x11223344eebbccaa';
            const status: EmberDeviceUpdate = EmberDeviceUpdate.STANDARD_SECURITY_UNSECURED_JOIN;
            const policyDecision: EmberJoinDecision = EmberJoinDecision.USE_PRECONFIGURED_KEY;
            const parentOfNewNodeId: NodeId = 4321;

            mockEzspEmitter.emit(EzspEvents.TRUST_CENTER_JOIN, newNodeId, newNodeEui64, status, policyDecision, parentOfNewNodeId);
            await flushPromises();

            expect(spyEmit).toHaveBeenCalledWith(Events.deviceJoined, {
                networkAddress: newNodeId,
                ieeeAddr: newNodeEui64,
            } as DeviceJoinedPayload);
        });

        it('Emits device leave on trust center join', async () => {
            const spyEmit = jest.spyOn(adapter, 'emit');
            const newNodeId: NodeId = 1234;
            const newNodeEui64: EUI64 = '0x11223344eebbccaa';
            const status: EmberDeviceUpdate = EmberDeviceUpdate.DEVICE_LEFT;
            const policyDecision: EmberJoinDecision = EmberJoinDecision.NO_ACTION;
            const parentOfNewNodeId: NodeId = 0xffff;

            mockEzspEmitter.emit(EzspEvents.TRUST_CENTER_JOIN, newNodeId, newNodeEui64, status, policyDecision, parentOfNewNodeId);
            await flushPromises();

            expect(spyEmit).toHaveBeenCalledWith(Events.deviceLeave, {
                networkAddress: newNodeId,
                ieeeAddr: newNodeEui64,
            } as DeviceLeavePayload);
        });

        it('Handles DENY_JOIN on trust center join', async () => {
            const newNodeId: NodeId = 1234;
            const newNodeEui64: EUI64 = '0x11223344eebbccaa';
            const status: EmberDeviceUpdate = EmberDeviceUpdate.STANDARD_SECURITY_UNSECURED_JOIN;
            const policyDecision: EmberJoinDecision = EmberJoinDecision.DENY_JOIN;
            const parentOfNewNodeId: NodeId = 4321;

            mockEzspEmitter.emit(EzspEvents.TRUST_CENTER_JOIN, newNodeId, newNodeEui64, status, policyDecision, parentOfNewNodeId);
            await flushPromises();

            expect(loggerSpies.warning).toHaveBeenCalledWith(
                `[TRUST CENTER] Device ${newNodeId}:${newNodeEui64} was denied joining via ${parentOfNewNodeId}.`,
                'zh:ember',
            );
        });

        it('Handles device join workaround requiring specific manufacturer code', async () => {
            const spyEmit = jest.spyOn(adapter, 'emit');
            const newNodeId: NodeId = 1234;
            const newNodeEui64: EUI64 = '0x54ef44ffeebbccaa';
            const status: EmberDeviceUpdate = EmberDeviceUpdate.STANDARD_SECURITY_UNSECURED_JOIN;
            const policyDecision: EmberJoinDecision = EmberJoinDecision.USE_PRECONFIGURED_KEY;
            const parentOfNewNodeId: NodeId = 4321;

            mockEzspEmitter.emit(EzspEvents.TRUST_CENTER_JOIN, newNodeId, newNodeEui64, status, policyDecision, parentOfNewNodeId);
            await flushPromises();

            expect(spyEmit).toHaveBeenCalledWith(Events.deviceJoined, {
                networkAddress: newNodeId,
                ieeeAddr: newNodeEui64,
            } as DeviceJoinedPayload);
            expect(mockEzspSetManufacturerCode).toHaveBeenCalledWith(Zcl.ManufacturerCode.LUMI_UNITED_TECHOLOGY_LTD_SHENZHEN);
            expect(mockManufCode).toStrictEqual(Zcl.ManufacturerCode.LUMI_UNITED_TECHOLOGY_LTD_SHENZHEN);
        });

        it('Triggers watchdog counters', async () => {
            await jest.advanceTimersByTimeAsync(3610000);
            expect(mockEzspReadAndClearCounters).toHaveBeenCalledTimes(1);
            console.log(loggerSpies.info.mock.calls);
            expect(loggerSpies.info).toHaveBeenCalledTimes(2);
            expect(loggerSpies.info.mock.calls[0][0]).toMatch(/[NCP COUNTERS]/);
            expect(loggerSpies.info.mock.calls[1][0]).toMatch(/[ASH COUNTERS]/);
        });

        it('Exports link keys', async () => {
            const k1Context: SecManContext = {
                coreKeyType: SecManKeyType.APP_LINK,
                keyIndex: 0,
                derivedType: SecManDerivedKeyType.NONE,
                eui64: '0x1122334455667788',
                multiNetworkIndex: 0,
                flags: SecManFlag.EUI_IS_VALID | SecManFlag.KEY_INDEX_IS_VALID,
                psaKeyAlgPermission: 0,
            };
            const k1 = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
            const k1Metadata: SecManAPSKeyMetadata = {
                bitmask: EmberKeyStructBitmask.HAS_INCOMING_FRAME_COUNTER | EmberKeyStructBitmask.HAS_OUTGOING_FRAME_COUNTER,
                outgoingFrameCounter: 1,
                incomingFrameCounter: 2,
                ttlInSeconds: 0,
            };
            const k2Context: SecManContext = {
                coreKeyType: SecManKeyType.APP_LINK,
                keyIndex: 1,
                derivedType: SecManDerivedKeyType.NONE,
                eui64: '0x2233445566778899',
                multiNetworkIndex: 0,
                flags: SecManFlag.EUI_IS_VALID | SecManFlag.KEY_INDEX_IS_VALID,
                psaKeyAlgPermission: 0,
            };
            const k2 = Buffer.from([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
            const k2Metadata: SecManAPSKeyMetadata = {
                bitmask: EmberKeyStructBitmask.HAS_INCOMING_FRAME_COUNTER | EmberKeyStructBitmask.HAS_OUTGOING_FRAME_COUNTER,
                outgoingFrameCounter: 10,
                incomingFrameCounter: 20,
                ttlInSeconds: 0,
            };
            const k3Context: SecManContext = {
                coreKeyType: SecManKeyType.APP_LINK,
                keyIndex: 2,
                derivedType: SecManDerivedKeyType.NONE,
                eui64: '0x3344556677889900',
                multiNetworkIndex: 0,
                flags: SecManFlag.EUI_IS_VALID | SecManFlag.KEY_INDEX_IS_VALID,
                psaKeyAlgPermission: 0,
            };
            const k3 = Buffer.from([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
            const k3Metadata: SecManAPSKeyMetadata = {
                bitmask: EmberKeyStructBitmask.HAS_INCOMING_FRAME_COUNTER | EmberKeyStructBitmask.HAS_OUTGOING_FRAME_COUNTER,
                outgoingFrameCounter: 100,
                incomingFrameCounter: 200,
                ttlInSeconds: 0,
            };

            mockEzspGetConfigurationValue.mockResolvedValueOnce([SLStatus.OK, 3]);
            mockEzspExportLinkKeyByIndex
                .mockResolvedValueOnce([SLStatus.OK, k1Context, {contents: k1} as SecManKey, k1Metadata])
                .mockResolvedValueOnce([SLStatus.OK, k2Context, {contents: k2} as SecManKey, k2Metadata])
                .mockResolvedValueOnce([SLStatus.OK, k3Context, {contents: k3} as SecManKey, k3Metadata]);

            const keys = await adapter.exportLinkKeys();

            expect(mockEzspExportLinkKeyByIndex).toHaveBeenCalledTimes(3);
            expect(keys).toStrictEqual([
                {
                    deviceEui64: k1Context.eui64,
                    key: {contents: k1},
                    outgoingFrameCounter: k1Metadata.outgoingFrameCounter,
                    incomingFrameCounter: k1Metadata.incomingFrameCounter,
                } as LinkKeyBackupData,
                {
                    deviceEui64: k2Context.eui64,
                    key: {contents: k2},
                    outgoingFrameCounter: k2Metadata.outgoingFrameCounter,
                    incomingFrameCounter: k2Metadata.incomingFrameCounter,
                } as LinkKeyBackupData,
                {
                    deviceEui64: k3Context.eui64,
                    key: {contents: k3},
                    outgoingFrameCounter: k3Metadata.outgoingFrameCounter,
                    incomingFrameCounter: k3Metadata.incomingFrameCounter,
                } as LinkKeyBackupData,
            ]);
        });

        it('Exports zero link keys', async () => {
            mockEzspGetConfigurationValue.mockResolvedValueOnce([SLStatus.OK, 0]);
            const keys = await adapter.exportLinkKeys();

            expect(keys).toStrictEqual([]);
        });

        it('Fails to export link keys due to failed table size retrieval', async () => {
            mockEzspGetConfigurationValue.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            await expect(adapter.exportLinkKeys()).rejects.toThrow(
                `[BACKUP] Failed to retrieve key table size from NCP with status=${SLStatus[SLStatus.FAIL]}.`,
            );
        });

        it('Fails to export link keys due to failed AES hashing', async () => {
            const k1Context: SecManContext = {
                coreKeyType: SecManKeyType.APP_LINK,
                keyIndex: 0,
                derivedType: SecManDerivedKeyType.NONE,
                eui64: '0x1122334455667788',
                multiNetworkIndex: 0,
                flags: SecManFlag.EUI_IS_VALID | SecManFlag.KEY_INDEX_IS_VALID,
                psaKeyAlgPermission: 0,
            };
            const k1 = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
            const k1Metadata: SecManAPSKeyMetadata = {
                bitmask: EmberKeyStructBitmask.HAS_INCOMING_FRAME_COUNTER | EmberKeyStructBitmask.HAS_OUTGOING_FRAME_COUNTER,
                outgoingFrameCounter: 1,
                incomingFrameCounter: 2,
                ttlInSeconds: 0,
            };

            mockEzspGetConfigurationValue.mockResolvedValueOnce([SLStatus.OK, 1]);
            mockEzspExportLinkKeyByIndex.mockResolvedValueOnce([SLStatus.OK, k1Context, {contents: k1} as SecManKey, k1Metadata]);
            mockEzspAesMmoHash.mockResolvedValueOnce([SLStatus.FAIL, {result: k1, length: k1.length} as EmberAesMmoHashContext]);

            await adapter.exportLinkKeys();

            expect(loggerSpies.error).toHaveBeenCalledWith(
                `[BACKUP] Failed to hash link key at index 0 with status=${SLStatus[SLStatus.FAIL]}. Omitting from backup.`,
                'zh:ember',
            );
        });

        it('Imports link keys', async () => {
            const k1Context: SecManContext = {
                coreKeyType: SecManKeyType.APP_LINK,
                keyIndex: 0,
                derivedType: SecManDerivedKeyType.NONE,
                eui64: '0x1122334455667788',
                multiNetworkIndex: 0,
                flags: SecManFlag.EUI_IS_VALID | SecManFlag.KEY_INDEX_IS_VALID,
                psaKeyAlgPermission: 0,
            };
            const k1 = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
            const k1Metadata: SecManAPSKeyMetadata = {
                bitmask: EmberKeyStructBitmask.HAS_INCOMING_FRAME_COUNTER | EmberKeyStructBitmask.HAS_OUTGOING_FRAME_COUNTER,
                outgoingFrameCounter: 1,
                incomingFrameCounter: 2,
                ttlInSeconds: 0,
            };
            const k2Context: SecManContext = {
                coreKeyType: SecManKeyType.APP_LINK,
                keyIndex: 1,
                derivedType: SecManDerivedKeyType.NONE,
                eui64: '0x2233445566778899',
                multiNetworkIndex: 0,
                flags: SecManFlag.EUI_IS_VALID | SecManFlag.KEY_INDEX_IS_VALID,
                psaKeyAlgPermission: 0,
            };
            const k2 = Buffer.from([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
            const k2Metadata: SecManAPSKeyMetadata = {
                bitmask: EmberKeyStructBitmask.HAS_INCOMING_FRAME_COUNTER | EmberKeyStructBitmask.HAS_OUTGOING_FRAME_COUNTER,
                outgoingFrameCounter: 10,
                incomingFrameCounter: 20,
                ttlInSeconds: 0,
            };
            const k3Context: SecManContext = {
                coreKeyType: SecManKeyType.APP_LINK,
                keyIndex: 2,
                derivedType: SecManDerivedKeyType.NONE,
                eui64: '0x3344556677889900',
                multiNetworkIndex: 0,
                flags: SecManFlag.EUI_IS_VALID | SecManFlag.KEY_INDEX_IS_VALID,
                psaKeyAlgPermission: 0,
            };
            const k3 = Buffer.from([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
            const k3Metadata: SecManAPSKeyMetadata = {
                bitmask: EmberKeyStructBitmask.HAS_INCOMING_FRAME_COUNTER | EmberKeyStructBitmask.HAS_OUTGOING_FRAME_COUNTER,
                outgoingFrameCounter: 100,
                incomingFrameCounter: 200,
                ttlInSeconds: 0,
            };
            mockEzspGetConfigurationValue.mockResolvedValueOnce([SLStatus.OK, 4]);
            mockEzspNetworkState.mockResolvedValueOnce(EmberNetworkStatus.NO_NETWORK);

            await adapter.importLinkKeys([
                {
                    deviceEui64: k1Context.eui64,
                    key: {contents: k1},
                    outgoingFrameCounter: k1Metadata.outgoingFrameCounter,
                    incomingFrameCounter: k1Metadata.incomingFrameCounter,
                },
                {
                    deviceEui64: k2Context.eui64,
                    key: {contents: k2},
                    outgoingFrameCounter: k2Metadata.outgoingFrameCounter,
                    incomingFrameCounter: k2Metadata.incomingFrameCounter,
                },
                {
                    deviceEui64: k3Context.eui64,
                    key: {contents: k3},
                    outgoingFrameCounter: k3Metadata.outgoingFrameCounter,
                    incomingFrameCounter: k3Metadata.incomingFrameCounter,
                },
            ]);

            expect(mockEzspImportLinkKey).toHaveBeenCalledTimes(3);
            expect(mockEzspEraseKeyTableEntry).toHaveBeenCalledTimes(1);
        });

        it('Imports zero link keys', async () => {
            await expect(adapter.importLinkKeys([])).resolves.toStrictEqual(undefined);
        });

        it('Failed to import link keys due to failed table size retrieval', async () => {
            mockEzspGetConfigurationValue.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            await expect(
                adapter.importLinkKeys([
                    // @ts-expect-error mock, unnecessary
                    {},
                ]),
            ).rejects.toThrow(`[BACKUP] Failed to retrieve key table size from NCP with status=${SLStatus[SLStatus.FAIL]}.`);
        });

        it('Failed to import link keys due to insufficient table size', async () => {
            mockEzspGetConfigurationValue.mockResolvedValueOnce([SLStatus.OK, 0]);

            await expect(
                adapter.importLinkKeys([
                    // @ts-expect-error mock, unnecessary
                    {},
                ]),
            ).rejects.toThrow(`[BACKUP] Current key table of 0 is too small to import backup of 1!`);
        });

        it('Failed to import link keys due to improper network state', async () => {
            mockEzspGetConfigurationValue.mockResolvedValueOnce([SLStatus.OK, 3]);
            mockEzspNetworkState.mockResolvedValueOnce(EmberNetworkStatus.JOINED_NETWORK);

            await expect(
                adapter.importLinkKeys([
                    // @ts-expect-error mock, unnecessary
                    {},
                ]),
            ).rejects.toThrow(
                `[BACKUP] Cannot import TC data while network is up, networkStatus=${EmberNetworkStatus[EmberNetworkStatus.JOINED_NETWORK]}.`,
            );
        });

        it('Failed to import link keys due to failed key set', async () => {
            const k1Context: SecManContext = {
                coreKeyType: SecManKeyType.APP_LINK,
                keyIndex: 0,
                derivedType: SecManDerivedKeyType.NONE,
                eui64: '0x1122334455667788',
                multiNetworkIndex: 0,
                flags: SecManFlag.EUI_IS_VALID | SecManFlag.KEY_INDEX_IS_VALID,
                psaKeyAlgPermission: 0,
            };
            const k1 = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
            const k1Metadata: SecManAPSKeyMetadata = {
                bitmask: EmberKeyStructBitmask.HAS_INCOMING_FRAME_COUNTER | EmberKeyStructBitmask.HAS_OUTGOING_FRAME_COUNTER,
                outgoingFrameCounter: 1,
                incomingFrameCounter: 2,
                ttlInSeconds: 0,
            };

            mockEzspGetConfigurationValue.mockResolvedValueOnce([SLStatus.OK, 3]);
            mockEzspNetworkState.mockResolvedValueOnce(EmberNetworkStatus.NO_NETWORK);
            mockEzspImportLinkKey.mockResolvedValueOnce(SLStatus.FAIL);

            await expect(
                adapter.importLinkKeys([
                    {
                        deviceEui64: k1Context.eui64,
                        key: {contents: k1},
                        outgoingFrameCounter: k1Metadata.outgoingFrameCounter,
                        incomingFrameCounter: k1Metadata.incomingFrameCounter,
                    },
                ]),
            ).rejects.toThrow(`[BACKUP] Failed to set key table entry at index 0 with status=${SLStatus[SLStatus.FAIL]}.`);
        });

        it('Failed to import link keys due to failed key erase', async () => {
            const k1Context: SecManContext = {
                coreKeyType: SecManKeyType.APP_LINK,
                keyIndex: 0,
                derivedType: SecManDerivedKeyType.NONE,
                eui64: '0x1122334455667788',
                multiNetworkIndex: 0,
                flags: SecManFlag.EUI_IS_VALID | SecManFlag.KEY_INDEX_IS_VALID,
                psaKeyAlgPermission: 0,
            };
            const k1 = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
            const k1Metadata: SecManAPSKeyMetadata = {
                bitmask: EmberKeyStructBitmask.HAS_INCOMING_FRAME_COUNTER | EmberKeyStructBitmask.HAS_OUTGOING_FRAME_COUNTER,
                outgoingFrameCounter: 1,
                incomingFrameCounter: 2,
                ttlInSeconds: 0,
            };

            mockEzspGetConfigurationValue.mockResolvedValueOnce([SLStatus.OK, 3]);
            mockEzspNetworkState.mockResolvedValueOnce(EmberNetworkStatus.NO_NETWORK);
            mockEzspEraseKeyTableEntry.mockResolvedValueOnce(SLStatus.FAIL);

            await expect(
                adapter.importLinkKeys([
                    {
                        deviceEui64: k1Context.eui64,
                        key: {contents: k1},
                        outgoingFrameCounter: k1Metadata.outgoingFrameCounter,
                        incomingFrameCounter: k1Metadata.incomingFrameCounter,
                    },
                ]),
            ).rejects.toThrow(`[BACKUP] Failed to erase key table entry at index 1 with status=${SLStatus[SLStatus.FAIL]}.`);
        });

        it('Broadcasts network key update', async () => {
            const p = adapter.broadcastNetworkKeyUpdate();

            await jest.advanceTimersByTimeAsync(100000);
            await expect(p).resolves.toStrictEqual(undefined);
            expect(mockEzspBroadcastNextNetworkKey).toHaveBeenCalledTimes(1);
            expect(mockEzspBroadcastNetworkKeySwitch).toHaveBeenCalledTimes(1);
        });

        it('Fails to broadcast network key update due to failed next key broadcast', async () => {
            mockEzspBroadcastNextNetworkKey.mockResolvedValueOnce(SLStatus.FAIL);

            const p = defuseRejection(adapter.broadcastNetworkKeyUpdate());

            await jest.advanceTimersByTimeAsync(100000);
            await expect(p).rejects.toThrow(`[TRUST CENTER] Failed to broadcast next network key with status=${SLStatus[SLStatus.FAIL]}.`);
            expect(mockEzspBroadcastNextNetworkKey).toHaveBeenCalledTimes(1);
            expect(mockEzspBroadcastNetworkKeySwitch).toHaveBeenCalledTimes(0);
        });

        it('Fails to broadcast network key update due to failed switch broadcast', async () => {
            mockEzspBroadcastNetworkKeySwitch.mockResolvedValueOnce(SLStatus.FAIL);

            const p = defuseRejection(adapter.broadcastNetworkKeyUpdate());

            await jest.advanceTimersByTimeAsync(100000);
            await expect(p).rejects.toThrow(`[TRUST CENTER] Failed to broadcast network key switch with status=${SLStatus[SLStatus.FAIL]}.`);
            expect(mockEzspBroadcastNextNetworkKey).toHaveBeenCalledTimes(1);
            expect(mockEzspBroadcastNetworkKeySwitch).toHaveBeenCalledTimes(1);
        });

        it('Handles NCP needing reset & init', async () => {
            const spyEmit = jest.spyOn(adapter, 'emit');
            const spyStop = jest.spyOn(adapter, 'stop');
            const spyStart = jest.spyOn(adapter, 'start');

            mockEzspEmitter.emit(EzspEvents.NCP_NEEDS_RESET_AND_INIT, EzspStatus.ERROR_SERIAL_INIT);
            await jest.advanceTimersByTimeAsync(5000);

            expect(spyEmit).toHaveBeenCalledTimes(0);
            expect(spyStop).toHaveBeenCalledTimes(1);
            expect(spyStart).toHaveBeenCalledTimes(1);
        });

        it('Emits adapter disconnected when NCP needs reset & init but queue is too high', async () => {
            jest.spyOn(
                // @ts-expect-error private
                adapter.queue,
                'count',
            ).mockReturnValueOnce(999);
            const spyEmit = jest.spyOn(adapter, 'emit');

            mockEzspEmitter.emit(EzspEvents.NCP_NEEDS_RESET_AND_INIT, EzspStatus.ERROR_SERIAL_INIT);
            await flushPromises();

            expect(spyEmit).toHaveBeenCalledWith(Events.disconnected);
        });

        it('Emits adapter disconnected when failed to reset & init NCP', async () => {
            jest.spyOn(adapter, 'stop').mockRejectedValueOnce('mock error');
            const spyEmit = jest.spyOn(adapter, 'emit');

            mockEzspEmitter.emit(EzspEvents.NCP_NEEDS_RESET_AND_INIT, EzspStatus.ERROR_SERIAL_INIT);
            await flushPromises();

            expect(spyEmit).toHaveBeenCalledWith(Events.disconnected);
        });

        it.each([
            ['getCoordinator', []],
            ['getNetworkParameters', []],
            ['changeChannel', [15]],
            ['permitJoin', [250, 1234]],
            ['permitJoin', [250, null]],
            ['lqi', [1234]],
            ['routingTable', [1234]],
            ['nodeDescriptor', [1234]],
            ['activeEndpoints', [1234]],
            ['simpleDescriptor', [1234, 1]],
            ['bind', [1234, '0x1122334455667788', 1, 0, '0xaabbccddee112233', 'endpoint', 1]],
            ['bind', [1234, '0x1122334455667788', 1, 0, 54, 'group', 1]],
            ['unbind', [1234, '0x1122334455667788', 1, 0, '0xaabbccddee112233', 'endpoint', 1]],
            ['unbind', [1234, '0x1122334455667788', 1, 0, 54, 'group', 1]],
            ['removeDevice', [1234]],
            ['removeDevice', [1234, '0x1122334455667788']],
            [
                'sendZclFrameToEndpoint',
                [
                    '0x1122334455667788',
                    1234,
                    1,
                    Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.SERVER_TO_CLIENT, true, null, 1, 1, 0, [{}], {}),
                    10000,
                    true,
                    false,
                    1,
                ],
            ],
            ['sendZclFrameToGroup', [32, Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.SERVER_TO_CLIENT, true, null, 1, 1, 0, [{}], {}), 1]],
            [
                'sendZclFrameToAll',
                [
                    1,
                    Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.SERVER_TO_CLIENT, true, null, 1, 1, 0, [{}], {}),
                    1,
                    ZSpec.BroadcastAddress.DEFAULT,
                ],
            ],
        ])('Adapter impl: throws when using non-InterPAN function %s while in InterPAN mode', async (funcName, args) => {
            await adapter.setChannelInterPAN(15);

            await expect(adapter[funcName](...args)).rejects.toThrow(`[INTERPAN MODE] Cannot execute non-InterPAN commands.`);
        });

        it('Adapter impl: getCoordinator', async () => {
            await expect(adapter.getCoordinator()).resolves.toStrictEqual({
                ieeeAddr: DEFAULT_COORDINATOR_IEEE,
                networkAddress: ZSpec.COORDINATOR_ADDRESS,
                manufacturerID: Zcl.ManufacturerCode.SILICON_LABORATORIES,
                endpoints: FIXED_ENDPOINTS.map((ep) => {
                    return {
                        profileID: ep.profileId,
                        ID: ep.endpoint,
                        deviceID: ep.deviceId,
                        inputClusters: ep.inClusterList.slice(), // copy
                        outputClusters: ep.outClusterList.slice(), // copy
                    };
                }),
            } as TsType.Coordinator);
        });

        it('Adapter impl: getCoordinatorVersion', async () => {
            await expect(adapter.getCoordinatorVersion()).resolves.toStrictEqual({
                type: `EmberZNet`,
                meta: {
                    ezsp: EZSP_PROTOCOL_VERSION,
                    revision: `8.0.0 [${EmberVersionType[EmberVersionType.GA]}]`,
                    build: 135,
                    major: 8,
                    minor: 0,
                    patch: 0,
                    special: 0,
                    type: EmberVersionType.GA,
                },
            } as TsType.CoordinatorVersion);
        });

        it('Adapter impl: reset soft', async () => {
            await expect(adapter.reset('soft')).rejects.toThrow(`Not supported 'soft'.`);
        });

        it('Adapter impl: reset hard', async () => {
            await expect(adapter.reset('hard')).rejects.toThrow(`Not supported 'hard'.`);
        });

        it('Adapter impl: supportsBackup', async () => {
            await expect(adapter.supportsBackup()).resolves.toStrictEqual(true);
        });

        it('Adapter impl: backup', async () => {
            await expect(adapter.backup([])).resolves.toStrictEqual({
                networkOptions: {
                    panId: DEFAULT_NETWORK_OPTIONS.panID, // uint16_t
                    extendedPanId: Buffer.from(DEFAULT_NETWORK_OPTIONS.extendedPanID!),
                    channelList: ZSpec.ALL_802_15_4_CHANNELS.slice(),
                    networkKey: Buffer.from(DEFAULT_BACKUP.network_key.key, 'hex'),
                    networkKeyDistribute: false,
                },
                logicalChannel: DEFAULT_NETWORK_OPTIONS.channelList[0],
                networkKeyInfo: {
                    sequenceNumber: DEFAULT_BACKUP.network_key.sequence_number,
                    frameCounter: DEFAULT_BACKUP.network_key.frame_counter,
                },
                securityLevel: SECURITY_LEVEL_Z3,
                networkUpdateId: 0,
                coordinatorIeeeAddress: Buffer.from(DEFAULT_BACKUP.coordinator_ieee, 'hex'),
                devices: [],
                ezsp: {
                    version: EZSP_PROTOCOL_VERSION,
                    hashed_tclk: Buffer.from(DEFAULT_BACKUP.stack_specific!.ezsp!.hashed_tclk!, 'hex'),
                },
            } as Backup);
        });

        it.each([
            [
                'failed get network parameters',
                () => {
                    mockEzspGetNetworkParameters.mockResolvedValueOnce([SLStatus.FAIL, 0, {}]);
                },
                `[BACKUP] Failed to get network parameters with status=${SLStatus[SLStatus.FAIL]}.`,
            ],
            [
                'failed get network keys info',
                () => {
                    mockEzspGetNetworkKeyInfo.mockResolvedValueOnce([SLStatus.FAIL, {}]);
                },
                `[BACKUP] Failed to get network keys info with status=${SLStatus[SLStatus.FAIL]}.`,
            ],
            [
                'no network key set',
                () => {
                    mockEzspGetNetworkKeyInfo.mockResolvedValueOnce([
                        SLStatus.OK,
                        {
                            networkKeySet: false,
                            alternateNetworkKeySet: false,
                            networkKeySequenceNumber: 123,
                            altNetworkKeySequenceNumber: 0,
                            networkKeyFrameCounter: 456,
                        } as SecManNetworkKeyInfo,
                    ]);
                },
                `[BACKUP] No network key set.`,
            ],
            [
                'failed export TC link key',
                () => {
                    mockEzspExportKey.mockResolvedValueOnce([SLStatus.FAIL, {}]);
                },
                `[BACKUP] Failed to export TC Link Key with status=${SLStatus[SLStatus.FAIL]}.`,
            ],
            [
                'failed export network key',
                () => {
                    mockEzspExportKey
                        .mockResolvedValueOnce([
                            SLStatus.OK,
                            {contents: Buffer.from(DEFAULT_BACKUP.stack_specific!.ezsp!.hashed_tclk!, 'hex')} as SecManKey,
                        ])
                        .mockResolvedValueOnce([SLStatus.FAIL, {}]);
                },
                `[BACKUP] Failed to export Network Key with status=${SLStatus[SLStatus.FAIL]}.`,
            ],
        ])('Adapter impl: throws when backup fails due to %s', async (_command, setup, error) => {
            setup();

            await expect(adapter.backup([])).rejects.toThrow(error);
        });

        it('Adapter impl: getNetworkParameters from cache', async () => {
            await expect(adapter.getNetworkParameters()).resolves.toStrictEqual({
                panID: DEFAULT_NETWORK_OPTIONS.panID,
                extendedPanID: parseInt(Buffer.from(DEFAULT_NETWORK_OPTIONS.extendedPanID!).toString('hex'), 16),
                channel: DEFAULT_NETWORK_OPTIONS.channelList[0],
            } as TsType.NetworkParameters);
            expect(mockEzspGetNetworkParameters).toHaveBeenCalledTimes(0);
        });

        it('Adapter impl: getNetworkParameters from NCP', async () => {
            adapter.clearNetworkCache();

            await expect(adapter.getNetworkParameters()).resolves.toStrictEqual({
                panID: DEFAULT_NETWORK_OPTIONS.panID,
                extendedPanID: parseInt(Buffer.from(DEFAULT_NETWORK_OPTIONS.extendedPanID!).toString('hex'), 16),
                channel: DEFAULT_NETWORK_OPTIONS.channelList[0],
            } as TsType.NetworkParameters);
            expect(mockEzspGetNetworkParameters).toHaveBeenCalledTimes(1);
        });

        it('Adapter impl: changeChannel', async () => {
            const spyResolveEvent = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'resolveEvent',
            );

            mockEzspSendBroadcast.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(EzspEvents.STACK_STATUS, SLStatus.ZIGBEE_CHANNEL_CHANGED);
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.changeChannel(25);

            await jest.advanceTimersByTimeAsync(1000);
            await p;
            expect(mockEzspSendBroadcast).toHaveBeenCalledTimes(1);
            expect(spyResolveEvent).toHaveBeenCalledWith(OneWaitressEvents.STACK_STATUS_CHANNEL_CHANGED);
        });

        it('Adapter impl: throws when changeChannel fails', async () => {
            mockEzspSendBroadcast.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            await expect(adapter.changeChannel(25)).rejects.toThrow(
                `[ZDO] Failed broadcast channel change to '25' with status=${SLStatus[SLStatus.FAIL]}.`,
            );
            expect(mockEzspSendBroadcast).toHaveBeenCalledTimes(1);
        });

        it('Adapter impl: setTransmitPower', async () => {
            await expect(adapter.setTransmitPower(10)).resolves.toStrictEqual(undefined);
            expect(mockEzspSetRadioPower).toHaveBeenCalledTimes(1);
        });

        it('Adapter impl: throws when setTransmitPower fails', async () => {
            mockEzspSetRadioPower.mockResolvedValueOnce(SLStatus.FAIL);

            await expect(adapter.setTransmitPower(10)).rejects.toThrow(`Failed to set transmit power to 10 status=${SLStatus[SLStatus.FAIL]}.`);
            expect(mockEzspSetRadioPower).toHaveBeenCalledTimes(1);
        });

        it('Adapter impl: addInstallCode without local CRC validation', async () => {
            await expect(adapter.addInstallCode('0x1122334455667788', Buffer.alloc(16))).resolves.toStrictEqual(undefined);
            expect(mockEzspAesMmoHash).toHaveBeenCalledTimes(1);
            expect(mockEzspImportTransientKey).toHaveBeenCalledTimes(1);
            expect(loggerSpies.debug).toHaveBeenCalledWith(`[ADD INSTALL CODE] Success for '0x1122334455667788'.`, 'zh:ember');
        });

        it('Adapter impl: addInstallCode with local CRC validation', async () => {
            await expect(
                adapter.addInstallCode('0x1122334455667788', Buffer.from('DD7ED5CDAA8E2C708B67D2B1573DB6843A5F', 'hex')),
            ).resolves.toStrictEqual(undefined);
            expect(mockEzspAesMmoHash).toHaveBeenCalledTimes(1);
            expect(mockEzspImportTransientKey).toHaveBeenCalledTimes(1);
            expect(loggerSpies.debug).toHaveBeenCalledWith(`[ADD INSTALL CODE] CRC validated for '0x1122334455667788'.`, 'zh:ember');
            expect(loggerSpies.debug).toHaveBeenCalledWith(`[ADD INSTALL CODE] Success for '0x1122334455667788'.`, 'zh:ember');
        });

        it('Adapter impl: throw when addInstallCode fails AES hashing', async () => {
            mockEzspAesMmoHash.mockResolvedValueOnce([SLStatus.FAIL, Buffer.alloc(16)]);

            await expect(adapter.addInstallCode('0x1122334455667788', Buffer.alloc(16))).rejects.toThrow(
                `[ADD INSTALL CODE] Failed AES hash for '0x1122334455667788' with status=${SLStatus[SLStatus.FAIL]}.`,
            );
            expect(mockEzspAesMmoHash).toHaveBeenCalledTimes(1);
            expect(mockEzspImportTransientKey).toHaveBeenCalledTimes(0);
        });

        it('Adapter impl: throw when addInstallCode fails import transient key', async () => {
            mockEzspImportTransientKey.mockResolvedValueOnce(SLStatus.FAIL);

            await expect(adapter.addInstallCode('0x1122334455667788', Buffer.alloc(16))).rejects.toThrow(
                `[ADD INSTALL CODE] Failed for '0x1122334455667788' with status=${SLStatus[SLStatus.FAIL]}.`,
            );
            expect(mockEzspAesMmoHash).toHaveBeenCalledTimes(1);
            expect(mockEzspImportTransientKey).toHaveBeenCalledTimes(1);
        });

        it('Adapter impl: throw when addInstallCode fails local CRC validation', async () => {
            await expect(adapter.addInstallCode('0x1122334455667788', Buffer.alloc(18))).rejects.toThrow(
                `[ADD INSTALL CODE] Failed for '0x1122334455667788'; invalid code CRC.`,
            );
            expect(mockEzspAesMmoHash).toHaveBeenCalledTimes(0);
            expect(mockEzspImportTransientKey).toHaveBeenCalledTimes(0);
        });

        it('Adapter impl: waitFor', async () => {
            const waiter = adapter.waitFor(1234, 1, Zcl.FrameType.GLOBAL, Zcl.Direction.CLIENT_TO_SERVER, 10, 0, 1, 15000);
            const spyCancel = jest.spyOn(waiter, 'cancel');

            expect(typeof waiter.cancel).toStrictEqual('function');
            expect(waiter.promise).toBeDefined();

            waiter.cancel();

            expect(spyCancel).toHaveReturned();
        });

        it('Adapter impl: permitJoin on all', async () => {
            const spyResolveEvent = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'resolveEvent',
            );

            // @ts-expect-error improper typing
            await adapter.permitJoin(250, null);
            await jest.advanceTimersByTimeAsync(1000);
            expect(mockEzspPermitJoining).toHaveBeenCalledWith(250);
            expect(mockEzspSendBroadcast).toHaveBeenCalledTimes(1);
            expect(spyResolveEvent).toHaveBeenCalledWith(OneWaitressEvents.STACK_STATUS_NETWORK_OPENED);

            // @ts-expect-error improper typing
            await adapter.permitJoin(0, null);
            await jest.advanceTimersByTimeAsync(1000);
            expect(mockEzspPermitJoining).toHaveBeenCalledWith(0);
            expect(mockEzspSendBroadcast).toHaveBeenCalledTimes(2);
            expect(spyResolveEvent).toHaveBeenCalledWith(OneWaitressEvents.STACK_STATUS_NETWORK_CLOSED);

            expect(mockEzspSetPolicy).toHaveBeenNthCalledWith(
                1,
                EzspPolicyId.TRUST_CENTER_POLICY,
                EzspDecisionBitmask.ALLOW_JOINS | EzspDecisionBitmask.ALLOW_UNSECURED_REJOINS,
            );
            expect(mockEzspSetPolicy).toHaveBeenNthCalledWith(2, EzspPolicyId.TRUST_CENTER_POLICY, EzspDecisionBitmask.ALLOW_UNSECURED_REJOINS);
        });

        it('Adapter impl: permitJoin on coordinator', async () => {
            const spyResolveEvent = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'resolveEvent',
            );

            await adapter.permitJoin(250, ZSpec.COORDINATOR_ADDRESS);
            await jest.advanceTimersByTimeAsync(1000);
            expect(mockEzspPermitJoining).toHaveBeenCalledWith(250);
            expect(mockEzspSendBroadcast).toHaveBeenCalledTimes(0);
            expect(spyResolveEvent).toHaveBeenCalledWith(OneWaitressEvents.STACK_STATUS_NETWORK_OPENED);

            await adapter.permitJoin(0, ZSpec.COORDINATOR_ADDRESS);
            await jest.advanceTimersByTimeAsync(1000);
            expect(mockEzspPermitJoining).toHaveBeenCalledWith(0);
            expect(mockEzspSendBroadcast).toHaveBeenCalledTimes(0);
            expect(spyResolveEvent).toHaveBeenCalledWith(OneWaitressEvents.STACK_STATUS_NETWORK_CLOSED);

            expect(mockEzspSetPolicy).toHaveBeenNthCalledWith(
                1,
                EzspPolicyId.TRUST_CENTER_POLICY,
                EzspDecisionBitmask.ALLOW_JOINS | EzspDecisionBitmask.ALLOW_UNSECURED_REJOINS,
            );
            expect(mockEzspSetPolicy).toHaveBeenNthCalledWith(2, EzspPolicyId.TRUST_CENTER_POLICY, EzspDecisionBitmask.ALLOW_UNSECURED_REJOINS);
        });

        it('Adapter impl: permitJoin on router', async () => {
            const spyResolveZDO = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'resolveZDO',
            );
            const sender = 1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.PERMIT_JOINING_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };
            const emitResponse = () => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(EzspEvents.ZDO_RESPONSE, apsFrame, sender, Buffer.from([1, Zdo.Status.SUCCESS]));
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            };

            mockEzspSendUnicast.mockImplementationOnce(emitResponse).mockImplementationOnce(emitResponse);

            let p = adapter.permitJoin(250, sender);
            await jest.advanceTimersByTimeAsync(1000);
            await p;
            expect(mockEzspSendUnicast).toHaveBeenCalledTimes(1);
            expect(spyResolveZDO).toHaveBeenCalledTimes(1);
            expect(spyResolveZDO).toHaveBeenCalledWith(sender, apsFrame, undefined);

            p = adapter.permitJoin(0, sender);
            await jest.advanceTimersByTimeAsync(1000);
            await p;
            expect(mockEzspSendUnicast).toHaveBeenCalledTimes(2);
            expect(spyResolveZDO).toHaveBeenCalledTimes(2);
            expect(spyResolveZDO).toHaveBeenCalledWith(sender, apsFrame, undefined);

            expect(mockEzspSetPolicy).toHaveBeenNthCalledWith(
                1,
                EzspPolicyId.TRUST_CENTER_POLICY,
                EzspDecisionBitmask.ALLOW_JOINS | EzspDecisionBitmask.ALLOW_UNSECURED_REJOINS,
            );
            expect(mockEzspSetPolicy).toHaveBeenNthCalledWith(2, EzspPolicyId.TRUST_CENTER_POLICY, EzspDecisionBitmask.ALLOW_UNSECURED_REJOINS);
        });

        it('Adapter impl: permitJoin restores temp manufacturer code', async () => {
            const spyResolveEvent = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'resolveEvent',
            );

            const newNodeId: NodeId = 1234;
            const newNodeEui64: EUI64 = '0x54ef44ffeebbccaa';
            const status: EmberDeviceUpdate = EmberDeviceUpdate.STANDARD_SECURITY_UNSECURED_JOIN;
            const policyDecision: EmberJoinDecision = EmberJoinDecision.USE_PRECONFIGURED_KEY;
            const parentOfNewNodeId: NodeId = 4321;

            mockEzspEmitter.emit(EzspEvents.TRUST_CENTER_JOIN, newNodeId, newNodeEui64, status, policyDecision, parentOfNewNodeId);
            await flushPromises();

            expect(mockEzspSetManufacturerCode).toHaveBeenCalledWith(Zcl.ManufacturerCode.LUMI_UNITED_TECHOLOGY_LTD_SHENZHEN);
            expect(mockManufCode).toStrictEqual(Zcl.ManufacturerCode.LUMI_UNITED_TECHOLOGY_LTD_SHENZHEN);

            await adapter.permitJoin(0, ZSpec.COORDINATOR_ADDRESS);
            await jest.advanceTimersByTimeAsync(1000);
            expect(mockEzspPermitJoining).toHaveBeenCalledWith(0);
            expect(mockEzspSendBroadcast).toHaveBeenCalledTimes(0);
            expect(spyResolveEvent).toHaveBeenCalledWith(OneWaitressEvents.STACK_STATUS_NETWORK_CLOSED);
            expect(mockEzspSetManufacturerCode).toHaveBeenCalledWith(Zcl.ManufacturerCode.SILICON_LABORATORIES);
            expect(mockManufCode).toStrictEqual(Zcl.ManufacturerCode.SILICON_LABORATORIES);
        });

        it('Adapter impl: throws when permitJoin on coordinator fails due to failed request', async () => {
            mockEzspPermitJoining.mockResolvedValueOnce(SLStatus.FAIL);

            await expect(adapter.permitJoin(250, 0)).rejects.toThrow(`[ZDO] Failed permit joining request with status=${SLStatus[SLStatus.FAIL]}.`);
        });

        it('Adapter impl: throws when permitJoin on router fails due to failed ZDO status', async () => {
            const spyResolveZDO = jest.spyOn(
                // @ts-expect-error private
                adapter.oneWaitress,
                'resolveZDO',
            );
            const sender = 1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.PERMIT_JOINING_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspEmitter.emit(EzspEvents.ZDO_RESPONSE, apsFrame, sender, Buffer.from([1, Zdo.Status.NOT_AUTHORIZED]));
            await flushPromises();

            expect(spyResolveZDO).toHaveBeenCalledTimes(1);
            expect(spyResolveZDO).toHaveBeenCalledWith(sender, apsFrame, new Zdo.StatusError(Zdo.Status.NOT_AUTHORIZED));
        });

        it('Adapter impl: throws when permitJoin on router fails due to failed request', async () => {
            mockEzspSendUnicast.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            await expect(adapter.permitJoin(250, 1234)).rejects.toThrow(
                `[ZDO] Failed permit joining request for '1234' with status=${SLStatus[SLStatus.FAIL]}.`,
            );
        });

        it('Adapter impl: throws when permitJoin fails to import ZIGBEE_PROFILE_INTEROPERABILITY_LINK_KEY', async () => {
            mockEzspImportTransientKey.mockResolvedValueOnce(SLStatus.FAIL);

            await expect(
                // @ts-expect-error improper typing
                adapter.permitJoin(250, null),
            ).rejects.toThrow(`[ZDO] Failed import transient key with status=${SLStatus[SLStatus.FAIL]}.`);
        });

        it('Adapter impl: throws when permitJoin fails to set TC policy', async () => {
            mockEzspSetPolicy.mockResolvedValueOnce(SLStatus.FAIL);

            await expect(
                // @ts-expect-error improper typing
                adapter.permitJoin(250, null),
            ).rejects.toThrow(`[ZDO] Failed set join policy with status=${SLStatus[SLStatus.FAIL]}.`);
        });

        it('Adapter impl: throws when stop permitJoin fails to restore TC policy', async () => {
            mockEzspSetPolicy.mockResolvedValueOnce(SLStatus.FAIL);

            await expect(
                // @ts-expect-error improper typing
                adapter.permitJoin(0, null),
            ).rejects.toThrow(`[ZDO] Failed set join policy with status=${SLStatus[SLStatus.FAIL]}.`);
        });

        it('Adapter impl: lqi', async () => {
            const sender: NodeId = 1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.LQI_TABLE_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspSendUnicast
                .mockImplementationOnce(() => {
                    setTimeout(async () => {
                        mockEzspEmitter.emit(
                            EzspEvents.ZDO_RESPONSE,
                            apsFrame,
                            sender,
                            Buffer.from([
                                1,
                                Zdo.Status.SUCCESS,
                                2, // neighborTableEntries
                                0, // startIndex
                                1, // entryCount
                                ...DEFAULT_NETWORK_OPTIONS.extendedPanID!, // extendedPanId
                                0x88,
                                0x77,
                                0x66,
                                0x55,
                                0x44,
                                0x33,
                                0x22,
                                0x11, // eui64
                                0x67,
                                0x45, // nwkAddress
                                0b00110010, // deviceTypeByte
                                0, // permitJoiningByte
                                0, // depth
                                234, // lqi
                            ]),
                        );
                        await flushPromises();
                    }, 300);

                    return [SLStatus.OK, ++mockAPSSequence];
                })
                .mockImplementationOnce(() => {
                    setTimeout(async () => {
                        mockEzspEmitter.emit(
                            EzspEvents.ZDO_RESPONSE,
                            apsFrame,
                            sender,
                            Buffer.from([
                                1,
                                Zdo.Status.SUCCESS,
                                2, // neighborTableEntries
                                1, // startIndex
                                1, // entryCount
                                ...DEFAULT_NETWORK_OPTIONS.extendedPanID!, // extendedPanId
                                0x44,
                                0x33,
                                0x22,
                                0x11,
                                0x88,
                                0x77,
                                0x66,
                                0x55, // eui64
                                0x23,
                                0x32, // nwkAddress
                                0b00010010, // deviceTypeByte
                                0, // permitJoiningByte
                                0, // depth
                                145, // lqi
                            ]),
                        );
                        await flushPromises();
                    }, 300);

                    return [SLStatus.OK, ++mockAPSSequence];
                });

            const p = adapter.lqi(sender);

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).resolves.toStrictEqual({
                neighbors: [
                    {
                        ieeeAddr: '0x1122334455667788',
                        networkAddress: 0x4567,
                        linkquality: 234,
                        relationship: 0x03,
                        depth: 0,
                    },
                    {
                        ieeeAddr: '0x5566778811223344',
                        networkAddress: 0x3223,
                        linkquality: 145,
                        relationship: 0x01,
                        depth: 0,
                    },
                ],
            } as TsType.LQI);
        });

        it('Adapter impl: throws when lqi fails request', async () => {
            const sender: NodeId = 1234;

            mockEzspSendUnicast.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const p = defuseRejection(adapter.lqi(sender));

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).rejects.toThrow(`[ZDO] Failed LQI request for '${sender}' (index '0') with status=${SLStatus[SLStatus.FAIL]}.`);
        });

        it('Adapter impl: routingTable', async () => {
            const sender: NodeId = 1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.ROUTING_TABLE_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspSendUnicast
                .mockImplementationOnce(() => {
                    setTimeout(async () => {
                        mockEzspEmitter.emit(
                            EzspEvents.ZDO_RESPONSE,
                            apsFrame,
                            sender,
                            Buffer.from([
                                1,
                                Zdo.Status.SUCCESS,
                                2, // routingTableEntries
                                0, // startIndex
                                1, // entryCount
                                0x98,
                                0x76, // destinationAddress
                                0, // statusByte
                                0x56,
                                0x34, // nextHopAddress
                            ]),
                        );
                        await flushPromises();
                    }, 300);

                    return [SLStatus.OK, ++mockAPSSequence];
                })
                .mockImplementationOnce(() => {
                    setTimeout(async () => {
                        mockEzspEmitter.emit(
                            EzspEvents.ZDO_RESPONSE,
                            apsFrame,
                            sender,
                            Buffer.from([
                                1,
                                Zdo.Status.SUCCESS,
                                2, // routingTableEntries
                                1, // startIndex
                                1, // entryCount
                                0x67,
                                0x45, // destinationAddress
                                0b011, // statusByte
                                0x85,
                                0x34, // nextHopAddress
                            ]),
                        );
                        await flushPromises();
                    }, 300);

                    return [SLStatus.OK, ++mockAPSSequence];
                });

            const p = adapter.routingTable(sender);

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).resolves.toStrictEqual({
                table: [
                    {
                        destinationAddress: 0x7698,
                        status: 'ACTIVE',
                        nextHop: 0x3456,
                    },
                    {
                        destinationAddress: 0x4567,
                        status: 'INACTIVE',
                        nextHop: 0x3485,
                    },
                ],
            } as TsType.RoutingTable);
        });

        it('Adapter impl: throws when routingTable fails request', async () => {
            const sender: NodeId = 1234;

            mockEzspSendUnicast.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const p = defuseRejection(adapter.routingTable(sender));

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).rejects.toThrow(`[ZDO] Failed routing table request for '${sender}' (index '0') with status=${SLStatus[SLStatus.FAIL]}.`);
        });

        it('Adapter impl: nodeDescriptor for coordinator', async () => {
            const sender: NodeId = 0x1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.NODE_DESCRIPTOR_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspSendUnicast.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(
                        EzspEvents.ZDO_RESPONSE,
                        apsFrame,
                        sender,
                        Buffer.from([
                            1,
                            Zdo.Status.SUCCESS,
                            0x34,
                            0x12, // nwkAddress
                            0b00000000, // nodeDescByte1
                            0, // nodeDescByte2
                            0, // macCapFlags
                            0x49,
                            0x10, // manufacturerCode
                            60, // maxBufSize
                            0,
                            0, // maxIncTxSize
                            0,
                            0, // serverMask
                            0,
                            0, // maxOutTxSize
                            0, // deprecated1
                        ]),
                    );
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.nodeDescriptor(sender);

            await jest.advanceTimersByTimeAsync(1000);
            await expect(p).resolves.toStrictEqual({
                type: 'Coordinator',
                manufacturerCode: 0x1049,
            } as TsType.NodeDescriptor);
        });

        it('Adapter impl: nodeDescriptor for router', async () => {
            const sender: NodeId = 0x1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.NODE_DESCRIPTOR_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };
            // for coverage of stackComplianceResivion detection
            const serverMask = Zdo.Utils.createServerMask({
                primaryTrustCenter: 0,
                backupTrustCenter: 0,
                deprecated1: 0,
                deprecated2: 0,
                deprecated3: 0,
                deprecated4: 0,
                networkManager: 0,
                reserved1: 0,
                reserved2: 0,
                stackComplianceResivion: 0,
            });

            mockEzspSendUnicast.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(
                        EzspEvents.ZDO_RESPONSE,
                        apsFrame,
                        sender,
                        Buffer.from([
                            1,
                            Zdo.Status.SUCCESS,
                            0x34,
                            0x12, // nwkAddress
                            0b00000001, // nodeDescByte1
                            0, // nodeDescByte2
                            0, // macCapFlags
                            0x56,
                            0x67, // manufacturerCode
                            60, // maxBufSize
                            0,
                            0, // maxIncTxSize
                            serverMask & 0xff,
                            (serverMask >> 8) & 0xff, // serverMask
                            0,
                            0, // maxOutTxSize
                            0, // deprecated1
                        ]),
                    );
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.nodeDescriptor(sender);

            await jest.advanceTimersByTimeAsync(1000);
            await expect(p).resolves.toStrictEqual({
                type: 'Router',
                manufacturerCode: 0x6756,
            } as TsType.NodeDescriptor);
            expect(loggerSpies.warning).toHaveBeenCalledWith(
                `[ZDO] Device '${sender}' is only compliant to revision 'pre-21' of the ZigBee specification (current revision: 22).`,
                'zh:ember',
            );
        });

        it('Adapter impl: nodeDescriptor for end device', async () => {
            const sender: NodeId = 0x1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.NODE_DESCRIPTOR_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };
            // for coverage of stackComplianceResivion detection
            const serverMask = Zdo.Utils.createServerMask({
                primaryTrustCenter: 0,
                backupTrustCenter: 0,
                deprecated1: 0,
                deprecated2: 0,
                deprecated3: 0,
                deprecated4: 0,
                networkManager: 0,
                reserved1: 0,
                reserved2: 0,
                stackComplianceResivion: 21,
            });

            mockEzspSendUnicast.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(
                        EzspEvents.ZDO_RESPONSE,
                        apsFrame,
                        sender,
                        Buffer.from([
                            1,
                            Zdo.Status.SUCCESS,
                            0x34,
                            0x12, // nwkAddress
                            0b00000010, // nodeDescByte1
                            0, // nodeDescByte2
                            0, // macCapFlags
                            0x56,
                            0x67, // manufacturerCode
                            60, // maxBufSize
                            0,
                            0, // maxIncTxSize
                            serverMask & 0xff,
                            (serverMask >> 8) & 0xff, // serverMask
                            0,
                            0, // maxOutTxSize
                            0, // deprecated1
                        ]),
                    );
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.nodeDescriptor(sender);

            await jest.advanceTimersByTimeAsync(1000);
            await expect(p).resolves.toStrictEqual({
                type: 'EndDevice',
                manufacturerCode: 0x6756,
            } as TsType.NodeDescriptor);
            expect(loggerSpies.warning).toHaveBeenCalledWith(
                `[ZDO] Device '${sender}' is only compliant to revision '21' of the ZigBee specification (current revision: 22).`,
                'zh:ember',
            );
        });

        it('Adapter impl: throws when nodeDescriptor fails request', async () => {
            const sender: NodeId = 1234;

            mockEzspSendUnicast.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const p = defuseRejection(adapter.nodeDescriptor(sender));

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).rejects.toThrow(`[ZDO] Failed node descriptor request for '${sender}' with status=${SLStatus[SLStatus.FAIL]}.`);
        });

        it('Adapter impl: activeEndpoints', async () => {
            const sender: NodeId = 0x1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.ACTIVE_ENDPOINTS_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspSendUnicast.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(
                        EzspEvents.ZDO_RESPONSE,
                        apsFrame,
                        sender,
                        Buffer.from([
                            1,
                            Zdo.Status.SUCCESS,
                            0x34,
                            0x12, // nwkAddress
                            2, // endpointCount
                            1,
                            43, // endpointList
                        ]),
                    );
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.activeEndpoints(sender);

            await jest.advanceTimersByTimeAsync(1000);
            await expect(p).resolves.toStrictEqual({
                endpoints: [1, 43],
            } as TsType.ActiveEndpoints);
        });

        it('Adapter impl: throws when activeEndpoints fails request', async () => {
            const sender: NodeId = 1234;

            mockEzspSendUnicast.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const p = defuseRejection(adapter.activeEndpoints(sender));

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).rejects.toThrow(`[ZDO] Failed active endpoints request for '${sender}' with status=${SLStatus[SLStatus.FAIL]}.`);
        });

        it('Adapter impl: simpleDescriptor', async () => {
            const sender: NodeId = 0x1234;
            const endpoint: number = 1;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspSendUnicast.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(
                        EzspEvents.ZDO_RESPONSE,
                        apsFrame,
                        sender,
                        Buffer.from([
                            1,
                            Zdo.Status.SUCCESS,
                            0x34,
                            0x12, // nwkAddress
                            18, // length
                            endpoint, // endpoint
                            0x33,
                            0x44, // profileId
                            0x00,
                            0x66, // deviceId
                            1, // deviceVersion
                            2, // inClusterCount
                            0x00,
                            0x00,
                            0x03,
                            0x00, // inClusterList
                            3, // outClusterCount
                            0x01,
                            0x00,
                            0x08,
                            0x00,
                            0x79,
                            0x23, // outClusterList
                        ]),
                    );
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.simpleDescriptor(sender, endpoint);

            await jest.advanceTimersByTimeAsync(1000);
            await expect(p).resolves.toStrictEqual({
                profileID: 0x4433,
                endpointID: endpoint,
                deviceID: 0x6600,
                inputClusters: [0x00, 0x03],
                outputClusters: [0x01, 0x08, 0x2379],
            } as TsType.SimpleDescriptor);
        });

        it('Adapter impl: throws when simpleDescriptor fails request', async () => {
            const sender: NodeId = 1234;

            mockEzspSendUnicast.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const p = defuseRejection(adapter.simpleDescriptor(sender, 1));

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).rejects.toThrow(
                `[ZDO] Failed simple descriptor request for '${sender}' endpoint '1' with status=${SLStatus[SLStatus.FAIL]}.`,
            );
        });

        it('Adapter impl: bind endpoint', async () => {
            const sender: NodeId = 0x1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.BIND_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspSendUnicast.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(EzspEvents.ZDO_RESPONSE, apsFrame, sender, Buffer.from([1, Zdo.Status.SUCCESS]));
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.bind(sender, '0x1122334455667788', 1, Zcl.Clusters.genBasic.ID, DEFAULT_COORDINATOR_IEEE, 'endpoint', 1);

            await jest.advanceTimersByTimeAsync(1000);
            await expect(p).resolves.toStrictEqual(undefined);

            // verify ZDO payload
            expect(mockEzspSendUnicast.mock.calls[0][4]).toStrictEqual(
                Buffer.from([
                    0x01, // seq
                    0x88,
                    0x77,
                    0x66,
                    0x55,
                    0x44,
                    0x33,
                    0x22,
                    0x11, // sourceIeeeAddress
                    0x01, // sourceEndpoint
                    0x00,
                    0x00, // clusterID
                    0x03, // type
                    0x11,
                    0x22,
                    0x33,
                    0x44,
                    0x55,
                    0x66,
                    0x77,
                    0x88, // destination DEFAULT_COORDINATOR_IEEE
                    0x01, // destinationEndpoint
                ]),
            );
        });

        it('Adapter impl: throws when bind endpoint fails request', async () => {
            const sender: NodeId = 1234;

            mockEzspSendUnicast.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const p = defuseRejection(
                adapter.bind(sender, '0x1122334455667788', 1, Zcl.Clusters.genBasic.ID, DEFAULT_COORDINATOR_IEEE, 'endpoint', 1),
            );

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).rejects.toThrow(
                `[ZDO] Failed bind request for '${sender}' destination '${DEFAULT_COORDINATOR_IEEE}' endpoint '1' with status=${SLStatus[SLStatus.FAIL]}.`,
            );
        });

        it('Adapter impl: bind group', async () => {
            const sender: NodeId = 0x1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.BIND_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspSendUnicast.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(EzspEvents.ZDO_RESPONSE, apsFrame, sender, Buffer.from([1, Zdo.Status.SUCCESS]));
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.bind(sender, '0x1122334455667788', 1, Zcl.Clusters.genBasic.ID, 987, 'group', 1);

            await jest.advanceTimersByTimeAsync(1000);
            await expect(p).resolves.toStrictEqual(undefined);

            // verify ZDO payload
            expect(mockEzspSendUnicast.mock.calls[0][4]).toStrictEqual(
                Buffer.from([
                    0x01, // seq
                    0x88,
                    0x77,
                    0x66,
                    0x55,
                    0x44,
                    0x33,
                    0x22,
                    0x11, // sourceIeeeAddress
                    0x01, // sourceEndpoint
                    0x00,
                    0x00, // clusterID
                    0x01, // type
                    0xdb,
                    0x03, // destination
                ]),
            );
        });

        it('Adapter impl: throws when bind group fails request', async () => {
            const sender: NodeId = 1234;
            const groupId: number = 987;

            mockEzspSendUnicast.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const p = defuseRejection(
                adapter.bind(
                    sender,
                    '0x1122334455667788',
                    1,
                    Zcl.Clusters.genBasic.ID,
                    groupId,
                    'group',
                    // @ts-expect-error improper typing
                    null,
                ),
            );

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).rejects.toThrow(
                `[ZDO] Failed bind request for '${sender}' destination '${groupId}' endpoint 'null' with status=${SLStatus[SLStatus.FAIL]}.`,
            );
        });

        it('Adapter impl: unbind endpoint', async () => {
            const sender: NodeId = 0x1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.UNBIND_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspSendUnicast.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(EzspEvents.ZDO_RESPONSE, apsFrame, sender, Buffer.from([1, Zdo.Status.SUCCESS]));
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.unbind(sender, '0x1122334455667788', 1, Zcl.Clusters.genBasic.ID, DEFAULT_COORDINATOR_IEEE, 'endpoint', 1);

            await jest.advanceTimersByTimeAsync(1000);
            await expect(p).resolves.toStrictEqual(undefined);

            // verify ZDO payload
            expect(mockEzspSendUnicast.mock.calls[0][4]).toStrictEqual(
                Buffer.from([
                    0x01, // seq
                    0x88,
                    0x77,
                    0x66,
                    0x55,
                    0x44,
                    0x33,
                    0x22,
                    0x11, // sourceIeeeAddress
                    0x01, // sourceEndpoint
                    0x00,
                    0x00, // clusterID
                    0x03, // type
                    0x11,
                    0x22,
                    0x33,
                    0x44,
                    0x55,
                    0x66,
                    0x77,
                    0x88, // destination DEFAULT_COORDINATOR_IEEE
                    0x01, // destinationEndpoint
                ]),
            );
        });

        it('Adapter impl: throws when unbind endpoint fails request', async () => {
            const sender: NodeId = 1234;

            mockEzspSendUnicast.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const p = defuseRejection(
                adapter.unbind(sender, '0x1122334455667788', 1, Zcl.Clusters.genBasic.ID, DEFAULT_COORDINATOR_IEEE, 'endpoint', 1),
            );

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).rejects.toThrow(
                `[ZDO] Failed unbind request for '${sender}' destination '${DEFAULT_COORDINATOR_IEEE}' endpoint '1' with status=${SLStatus[SLStatus.FAIL]}.`,
            );
        });

        it('Adapter impl: unbind group', async () => {
            const sender: NodeId = 0x1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.UNBIND_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspSendUnicast.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(EzspEvents.ZDO_RESPONSE, apsFrame, sender, Buffer.from([1, Zdo.Status.SUCCESS]));
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.unbind(sender, '0x1122334455667788', 1, Zcl.Clusters.genBasic.ID, 987, 'group', 1);

            await jest.advanceTimersByTimeAsync(1000);
            await expect(p).resolves.toStrictEqual(undefined);

            // verify ZDO payload
            expect(mockEzspSendUnicast.mock.calls[0][4]).toStrictEqual(
                Buffer.from([
                    0x01, // seq
                    0x88,
                    0x77,
                    0x66,
                    0x55,
                    0x44,
                    0x33,
                    0x22,
                    0x11, // sourceIeeeAddress
                    0x01, // sourceEndpoint
                    0x00,
                    0x00, // clusterID
                    0x01, // type
                    0xdb,
                    0x03, // destination
                ]),
            );
        });

        it('Adapter impl: throws when unbind group fails request', async () => {
            const sender: NodeId = 1234;
            const groupId: number = 987;

            mockEzspSendUnicast.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const p = defuseRejection(
                adapter.unbind(
                    sender,
                    '0x1122334455667788',
                    1,
                    Zcl.Clusters.genBasic.ID,
                    groupId,
                    'group',
                    // @ts-expect-error improper typing
                    null,
                ),
            );

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).rejects.toThrow(
                `[ZDO] Failed unbind request for '${sender}' destination '${groupId}' endpoint 'null' with status=${SLStatus[SLStatus.FAIL]}.`,
            );
        });

        it('Adapter impl: removeDevice', async () => {
            const sender: NodeId = 0x1234;
            const apsFrame: EmberApsFrame = {
                profileId: Zdo.ZDO_PROFILE_ID,
                clusterId: Zdo.ClusterId.LEAVE_RESPONSE,
                sourceEndpoint: Zdo.ZDO_ENDPOINT,
                destinationEndpoint: Zdo.ZDO_ENDPOINT,
                options: 0,
                groupId: 0,
                sequence: 0,
            };

            mockEzspSendUnicast.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(EzspEvents.ZDO_RESPONSE, apsFrame, sender, Buffer.from([1, Zdo.Status.SUCCESS]));
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.removeDevice(sender, '0x1122334455667788');

            await jest.advanceTimersByTimeAsync(1000);
            await expect(p).resolves.toStrictEqual(undefined);
        });

        it('Adapter impl: throws when removeDevice fails request', async () => {
            const sender: NodeId = 1234;
            const ieee: EUI64 = '0x1122334455667788';

            mockEzspSendUnicast.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const p = defuseRejection(adapter.removeDevice(sender, ieee));

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).rejects.toThrow(
                `[ZDO] Failed remove device request for '${sender}' target '${ieee}' with status=${SLStatus[SLStatus.FAIL]}.`,
            );
        });

        it('Adapter impl: sendZclFrameToEndpoint with command response with fixed source endpoint', async () => {
            const networkAddress: NodeId = 1234;
            const endpoint: number = 1;
            const sourceEndpoint = FIXED_ENDPOINTS[0].endpoint;
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                true,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );
            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS,
                groupId: 0,
                sequence: 0, // set by stack
            };
            const lastHopLqi: number = 234;
            // Received Zigbee message from '0x', type 'readResponse', cluster 'genBasic', data '{"zclVersion":3}' from endpoint 1 with groupID 0
            const messageContents = Buffer.from('1803010000002003', 'hex');

            mockEzspSend.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(
                        EzspEvents.INCOMING_MESSAGE,
                        EmberIncomingMessageType.UNICAST,
                        reverseApsFrame(apsFrame),
                        lastHopLqi,
                        networkAddress,
                        messageContents,
                    );
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.sendZclFrameToEndpoint('0x1122334455667788', networkAddress, endpoint, zclFrame, 10000, false, false, sourceEndpoint);

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).resolves.toStrictEqual({
                clusterID: apsFrame.clusterId,
                header: Zcl.Header.fromBuffer(messageContents),
                address: networkAddress,
                data: messageContents,
                endpoint: apsFrame.destinationEndpoint,
                linkquality: lastHopLqi,
                groupID: apsFrame.groupId,
                wasBroadcast: false,
                destinationEndpoint: apsFrame.sourceEndpoint,
            } as ZclPayload);
            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.DIRECT, networkAddress, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it('Adapter impl: sendZclFrameToEndpoint with command response with other source endpoint', async () => {
            const networkAddress: NodeId = 1234;
            const endpoint: number = 1;
            const sourceEndpoint = 3;
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                true,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );
            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS,
                groupId: 0,
                sequence: 0, // set by stack
            };
            const lastHopLqi: number = 234;
            // Received Zigbee message from '0x', type 'readResponse', cluster 'genBasic', data '{"zclVersion":3}' from endpoint 1 with groupID 0
            const messageContents = Buffer.from('1803010000002003', 'hex');

            mockEzspSend.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(
                        EzspEvents.INCOMING_MESSAGE,
                        EmberIncomingMessageType.UNICAST,
                        reverseApsFrame(apsFrame),
                        lastHopLqi,
                        networkAddress,
                        messageContents,
                    );
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.sendZclFrameToEndpoint('0x1122334455667788', networkAddress, endpoint, zclFrame, 10000, false, false, sourceEndpoint);

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).resolves.toStrictEqual({
                clusterID: apsFrame.clusterId,
                header: Zcl.Header.fromBuffer(messageContents),
                address: networkAddress,
                data: messageContents,
                endpoint: apsFrame.destinationEndpoint,
                linkquality: lastHopLqi,
                groupID: apsFrame.groupId,
                wasBroadcast: false,
                destinationEndpoint: apsFrame.sourceEndpoint,
            } as ZclPayload);
            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.DIRECT, networkAddress, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it('Adapter impl: sendZclFrameToEndpoint with command response with no source endpoint', async () => {
            const networkAddress: NodeId = 1234;
            const endpoint: number = 1;
            const sourceEndpoint = FIXED_ENDPOINTS[0].endpoint;
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                true,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );
            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS,
                groupId: 0,
                sequence: 0, // set by stack
            };
            const lastHopLqi: number = 234;
            // Received Zigbee message from '0x', type 'readResponse', cluster 'genBasic', data '{"zclVersion":3}' from endpoint 1 with groupID 0
            const messageContents = Buffer.from('1803010000002003', 'hex');

            mockEzspSend.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(
                        EzspEvents.INCOMING_MESSAGE,
                        EmberIncomingMessageType.UNICAST,
                        reverseApsFrame(apsFrame),
                        lastHopLqi,
                        networkAddress,
                        messageContents,
                    );
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.sendZclFrameToEndpoint('0x1122334455667788', networkAddress, endpoint, zclFrame, 10000, false, false);

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).resolves.toStrictEqual({
                clusterID: apsFrame.clusterId,
                header: Zcl.Header.fromBuffer(messageContents),
                address: networkAddress,
                data: messageContents,
                endpoint: apsFrame.destinationEndpoint,
                linkquality: lastHopLqi,
                groupID: apsFrame.groupId,
                wasBroadcast: false,
                destinationEndpoint: apsFrame.sourceEndpoint,
            } as ZclPayload);
            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.DIRECT, networkAddress, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it.each([
            ['NO_TX_SPACE', EzspStatus.NO_TX_SPACE],
            ['NOT_CONNECTED', EzspStatus.NOT_CONNECTED],
        ])('Adapter impl: recovers when sendZclFrameToEndpoint throws %s status', async (_statusName, status) => {
            const networkAddress: NodeId = 1234;
            const endpoint: number = 1;
            const sourceEndpoint = FIXED_ENDPOINTS[0].endpoint;
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                true,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );
            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS,
                groupId: 0,
                sequence: 0, // set by stack
            };
            const lastHopLqi: number = 234;
            // Received Zigbee message from '0x', type 'readResponse', cluster 'genBasic', data '{"zclVersion":3}' from endpoint 1 with groupID 0
            const messageContents = Buffer.from('1803010000002003', 'hex');

            mockEzspSend.mockRejectedValueOnce(new EzspError(status)).mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(
                        EzspEvents.INCOMING_MESSAGE,
                        EmberIncomingMessageType.UNICAST,
                        reverseApsFrame(apsFrame),
                        lastHopLqi,
                        networkAddress,
                        messageContents,
                    );
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.sendZclFrameToEndpoint('0x1122334455667788', networkAddress, endpoint, zclFrame, 10000, false, false, sourceEndpoint);

            await jest.advanceTimersByTimeAsync(10000);
            await expect(p).resolves.toStrictEqual({
                clusterID: apsFrame.clusterId,
                header: Zcl.Header.fromBuffer(messageContents),
                address: networkAddress,
                data: messageContents,
                endpoint: apsFrame.destinationEndpoint,
                linkquality: lastHopLqi,
                groupID: apsFrame.groupId,
                wasBroadcast: false,
                destinationEndpoint: apsFrame.sourceEndpoint,
            } as ZclPayload);
            expect(mockEzspSend).toHaveBeenCalledTimes(2);
            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.DIRECT, networkAddress, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it.each([
            ['ZIGBEE_MAX_MESSAGE_LIMIT_REACHED', SLStatus.ZIGBEE_MAX_MESSAGE_LIMIT_REACHED],
            ['BUSY', SLStatus.BUSY],
            ['NETWORK_DOWN', SLStatus.NETWORK_DOWN],
        ])('Adapter impl: recovers when sendZclFrameToEndpoint get %s status from NCP', async (_statusName, status) => {
            const networkAddress: NodeId = 1234;
            const endpoint: number = 1;
            const sourceEndpoint = FIXED_ENDPOINTS[0].endpoint;
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                true,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );
            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS,
                groupId: 0,
                sequence: 0, // set by stack
            };
            const lastHopLqi: number = 234;
            // Received Zigbee message from '0x', type 'readResponse', cluster 'genBasic', data '{"zclVersion":3}' from endpoint 1 with groupID 0
            const messageContents = Buffer.from('1803010000002003', 'hex');

            mockEzspSend.mockResolvedValueOnce([status, 0]).mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(
                        EzspEvents.INCOMING_MESSAGE,
                        EmberIncomingMessageType.UNICAST,
                        reverseApsFrame(apsFrame),
                        lastHopLqi,
                        networkAddress,
                        messageContents,
                    );
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.sendZclFrameToEndpoint('0x1122334455667788', networkAddress, endpoint, zclFrame, 10000, false, false, sourceEndpoint);

            await jest.advanceTimersByTimeAsync(10000);
            await expect(p).resolves.toStrictEqual({
                clusterID: apsFrame.clusterId,
                header: Zcl.Header.fromBuffer(messageContents),
                address: networkAddress,
                data: messageContents,
                endpoint: apsFrame.destinationEndpoint,
                linkquality: lastHopLqi,
                groupID: apsFrame.groupId,
                wasBroadcast: false,
                destinationEndpoint: apsFrame.sourceEndpoint,
            } as ZclPayload);
            expect(mockEzspSend).toHaveBeenCalledTimes(2);
            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.DIRECT, networkAddress, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it('Adapter impl: throws when sendZclFrameToEndpoint throws NO_TX_SPACE status and recovery disabled', async () => {
            const networkAddress: NodeId = 1234;
            const endpoint: number = 1;
            const sourceEndpoint = FIXED_ENDPOINTS[0].endpoint;
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                true,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );
            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS,
                groupId: 0,
                sequence: 0, // set by stack
            };

            mockEzspSend.mockRejectedValueOnce(new EzspError(EzspStatus.NO_TX_SPACE));

            const p = defuseRejection(
                adapter.sendZclFrameToEndpoint(
                    '0x1122334455667788',
                    networkAddress,
                    endpoint,
                    zclFrame,
                    10000,
                    false,
                    true, // disable recovery
                    sourceEndpoint,
                ),
            );

            await jest.advanceTimersByTimeAsync(10000);
            await expect(p).rejects.toThrow(`~x~> [ZCL to=${networkAddress}] Failed to send request with status=${SLStatus[SLStatus.BUSY]}.`);
            expect(mockEzspSend).toHaveBeenCalledTimes(1);
            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.DIRECT, networkAddress, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it('Adapter impl: throws when sendZclFrameToEndpoint get BUSY status from NCP and recovery disabled', async () => {
            const networkAddress: NodeId = 1234;
            const endpoint: number = 1;
            const sourceEndpoint = FIXED_ENDPOINTS[0].endpoint;
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                true,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );
            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS,
                groupId: 0,
                sequence: 0, // set by stack
            };

            mockEzspSend.mockResolvedValueOnce([SLStatus.BUSY, 0]);

            const p = defuseRejection(
                adapter.sendZclFrameToEndpoint(
                    '0x1122334455667788',
                    networkAddress,
                    endpoint,
                    zclFrame,
                    10000,
                    false,
                    true, // disable recovery
                    sourceEndpoint,
                ),
            );

            await jest.advanceTimersByTimeAsync(10000);
            await expect(p).rejects.toThrow(`~x~> [ZCL to=${networkAddress}] Failed to send request with status=${SLStatus[SLStatus.BUSY]}.`);
            expect(mockEzspSend).toHaveBeenCalledTimes(1);
            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.DIRECT, networkAddress, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it('Adapter impl: throws when sendZclFrameToEndpoint get BUSY status from NCP and exceeded max attempts', async () => {
            const networkAddress: NodeId = 1234;
            const endpoint: number = 1;
            const sourceEndpoint = FIXED_ENDPOINTS[0].endpoint;
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                true,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );
            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS,
                groupId: 0,
                sequence: 0, // set by stack
            };

            mockEzspSend
                .mockResolvedValueOnce([SLStatus.BUSY, 0])
                .mockResolvedValueOnce([SLStatus.BUSY, 0])
                .mockResolvedValueOnce([SLStatus.BUSY, 0]);

            const p = defuseRejection(
                adapter.sendZclFrameToEndpoint(
                    '0x1122334455667788',
                    networkAddress,
                    endpoint,
                    zclFrame,
                    10000,
                    false,
                    false, // disable recovery
                    sourceEndpoint,
                ),
            );

            await jest.advanceTimersByTimeAsync(10000);
            await expect(p).rejects.toThrow(`~x~> [ZCL to=${networkAddress}] Failed to send request with status=${SLStatus[SLStatus.BUSY]}.`);
            expect(mockEzspSend).toHaveBeenCalledTimes(3);
            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.DIRECT, networkAddress, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it('Adapter impl: throws when sendZclFrameToEndpoint request fails', async () => {
            const networkAddress: NodeId = 1234;
            const endpoint: number = 1;
            const sourceEndpoint = FIXED_ENDPOINTS[0].endpoint;
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                true,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );
            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS,
                groupId: 0,
                sequence: 0, // set by stack
            };

            mockEzspSend.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const p = defuseRejection(
                adapter.sendZclFrameToEndpoint(
                    '0x1122334455667788',
                    networkAddress,
                    endpoint,
                    zclFrame,
                    10000,
                    false,
                    false, // disable recovery
                    sourceEndpoint,
                ),
            );

            await jest.advanceTimersByTimeAsync(10000);
            await expect(p).rejects.toThrow(`~x~> [ZCL to=${networkAddress}] Failed to send request with status=${SLStatus[SLStatus.FAIL]}.`);
            expect(mockEzspSend).toHaveBeenCalledTimes(1);
            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.DIRECT, networkAddress, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it('Adapter impl: sendZclFrameToEndpoint with default response', async () => {
            const networkAddress: NodeId = 1234;
            const endpoint: number = 3;
            const sourceEndpoint = FIXED_ENDPOINTS[0].endpoint;
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                false,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );
            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS,
                groupId: 0,
                sequence: 0, // set by stack
            };
            const lastHopLqi: number = 234;
            // defaultRsp with cmdId=0, status=0
            const messageContents = Buffer.from('18030b0000', 'hex');

            mockEzspSend.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(
                        EzspEvents.INCOMING_MESSAGE,
                        EmberIncomingMessageType.UNICAST,
                        reverseApsFrame(apsFrame),
                        lastHopLqi,
                        networkAddress,
                        messageContents,
                    );
                    await flushPromises();
                }, 300);

                return [SLStatus.OK, ++mockAPSSequence];
            });

            const p = adapter.sendZclFrameToEndpoint('0x1122334455667788', networkAddress, endpoint, zclFrame, 10000, true, false, sourceEndpoint);

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).resolves.toStrictEqual({
                clusterID: apsFrame.clusterId,
                header: Zcl.Header.fromBuffer(messageContents),
                address: networkAddress,
                data: messageContents,
                endpoint: apsFrame.destinationEndpoint,
                linkquality: lastHopLqi,
                groupID: apsFrame.groupId,
                wasBroadcast: false,
                destinationEndpoint: apsFrame.sourceEndpoint,
            } as ZclPayload);
            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.DIRECT, networkAddress, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it('Adapter impl: sendZclFrameToEndpoint without response', async () => {
            const networkAddress: NodeId = 1234;
            const endpoint: number = 3;
            const sourceEndpoint = FIXED_ENDPOINTS[0].endpoint;
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                true,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );

            const p = adapter.sendZclFrameToEndpoint('0x1122334455667788', networkAddress, endpoint, zclFrame, 10000, true, false, sourceEndpoint);

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).resolves.toStrictEqual(null);

            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS & ~EmberApsOption.RETRY,
                groupId: 0,
                sequence: 0, // set by stack
            };

            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.DIRECT, networkAddress, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it('Adapter impl: sendZclFrameToGroup with source endpoint', async () => {
            const groupId: number = 32;
            const zclFrame = Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.SERVER_TO_CLIENT, true, null, 1, 1, 0, [{}], {});
            const p = adapter.sendZclFrameToGroup(groupId, zclFrame, 2);

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).resolves.toStrictEqual(undefined);

            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint: 2,
                destinationEndpoint: 0xff,
                options: DEFAULT_APS_OPTIONS,
                groupId,
                sequence: 0, // set by stack
            };

            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.MULTICAST, groupId, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it('Adapter impl: sendZclFrameToGroup with default source endpoint', async () => {
            const groupId: number = 32;
            const zclFrame = Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.SERVER_TO_CLIENT, true, null, 1, 1, 0, [{}], {});
            const p = adapter.sendZclFrameToGroup(groupId, zclFrame);

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).resolves.toStrictEqual(undefined);

            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint: FIXED_ENDPOINTS[0].endpoint,
                destinationEndpoint: 0xff,
                options: DEFAULT_APS_OPTIONS,
                groupId,
                sequence: 0, // set by stack
            };

            expect(mockEzspSend).toHaveBeenCalledWith(EmberOutgoingMessageType.MULTICAST, groupId, apsFrame, zclFrame.toBuffer(), 0, 0);
        });

        it('Adapter impl: throws when sendZclFrameToGroup fails request', async () => {
            mockEzspSend.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const groupId: number = 32;
            const zclFrame = Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.SERVER_TO_CLIENT, true, null, 1, 1, 0, [{}], {});
            const p = defuseRejection(adapter.sendZclFrameToGroup(groupId, zclFrame, 1));

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).rejects.toThrow(`~x~> [ZCL GROUP] Failed to send with status=${SLStatus[SLStatus.FAIL]}.`);
            expect(mockEzspSend).toHaveBeenCalledTimes(1);
        });

        it('Adapter impl: sendZclFrameToAll with fixed endpoint', async () => {
            const endpoint: number = 32;
            const zclFrame = Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.SERVER_TO_CLIENT, true, null, 1, 1, 0, [{}], {});
            const sourceEndpoint = FIXED_ENDPOINTS[0].endpoint;
            const p = adapter.sendZclFrameToAll(endpoint, zclFrame, sourceEndpoint, ZSpec.BroadcastAddress.DEFAULT);

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).resolves.toStrictEqual(undefined);

            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS,
                groupId: ZSpec.BroadcastAddress.DEFAULT,
                sequence: 0, // set by stack
            };

            expect(mockEzspSend).toHaveBeenCalledWith(
                EmberOutgoingMessageType.BROADCAST,
                ZSpec.BroadcastAddress.DEFAULT,
                apsFrame,
                zclFrame.toBuffer(),
                0,
                0,
            );
        });

        it('Adapter impl: sendZclFrameToAll with other endpoint', async () => {
            const endpoint: number = 32;
            const zclFrame = Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.SERVER_TO_CLIENT, true, null, 1, 1, 0, [{}], {});
            const sourceEndpoint = 3;
            const p = adapter.sendZclFrameToAll(endpoint, zclFrame, sourceEndpoint, ZSpec.BroadcastAddress.DEFAULT);

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).resolves.toStrictEqual(undefined);

            const apsFrame: EmberApsFrame = {
                profileId: FIXED_ENDPOINTS[0].profileId,
                clusterId: zclFrame.cluster.ID,
                sourceEndpoint,
                destinationEndpoint: endpoint,
                options: DEFAULT_APS_OPTIONS,
                groupId: ZSpec.BroadcastAddress.DEFAULT,
                sequence: 0, // set by stack
            };

            expect(mockEzspSend).toHaveBeenCalledWith(
                EmberOutgoingMessageType.BROADCAST,
                ZSpec.BroadcastAddress.DEFAULT,
                apsFrame,
                zclFrame.toBuffer(),
                0,
                0,
            );
        });

        it('Adapter impl: throws when sendZclFrameToAll fails request', async () => {
            mockEzspSend.mockResolvedValueOnce([SLStatus.FAIL, 0]);

            const endpoint: number = 32;
            const zclFrame = Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.SERVER_TO_CLIENT, true, null, 1, 1, 0, [{}], {});
            const p = defuseRejection(adapter.sendZclFrameToAll(endpoint, zclFrame, 1, ZSpec.BroadcastAddress.DEFAULT));

            await jest.advanceTimersByTimeAsync(5000);
            await expect(p).rejects.toThrow(`~x~> [ZCL BROADCAST] Failed to send with status=${SLStatus[SLStatus.FAIL]}.`);
            expect(mockEzspSend).toHaveBeenCalledTimes(1);
        });

        it('Adapter impl: setChannelInterPAN', async () => {
            await expect(adapter.setChannelInterPAN(15)).resolves.toStrictEqual(undefined);
            expect(mockEzspSetLogicalAndRadioChannel).toHaveBeenCalledWith(15);
        });

        it('Adapter impl: throws when setChannelInterPAN fails request', async () => {
            mockEzspSetLogicalAndRadioChannel.mockResolvedValueOnce(SLStatus.FAIL);

            await expect(adapter.setChannelInterPAN(15)).rejects.toThrow(
                `Failed to set InterPAN channel to '15' with status=${SLStatus[SLStatus.FAIL]}.`,
            );
            expect(mockEzspSetLogicalAndRadioChannel).toHaveBeenCalledWith(15);
        });

        it('Adapter impl: sendZclFrameInterPANToIeeeAddr', async () => {
            const ieee: EUI64 = '0x1122334455667788';
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                false,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );

            await expect(adapter.sendZclFrameInterPANToIeeeAddr(zclFrame, ieee)).resolves.toStrictEqual(undefined);
            expect(mockEzspSendRawMessage).toHaveBeenCalledTimes(1);
            expect(mockEzspSendRawMessage).toHaveBeenCalledWith(expect.any(Buffer), 1, true);
        });

        it('Adapter impl: throws when sendZclFrameInterPANToIeeeAddr request fails', async () => {
            mockEzspSendRawMessage.mockResolvedValueOnce(SLStatus.BUSY);

            const ieee: EUI64 = '0x1122334455667788';
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                false,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );

            await expect(adapter.sendZclFrameInterPANToIeeeAddr(zclFrame, ieee)).rejects.toThrow(
                `~x~> [ZCL TOUCHLINK to=${ieee}] Failed to send with status=${SLStatus[SLStatus.BUSY]}.`,
            );
            expect(mockEzspSendRawMessage).toHaveBeenCalledTimes(1);
            expect(mockEzspSendRawMessage).toHaveBeenCalledWith(expect.any(Buffer), 1, true);
        });

        it('Adapter impl: sendZclFrameInterPANBroadcast', async () => {
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.SPECIFIC,
                Zcl.Direction.CLIENT_TO_SERVER,
                true,
                null,
                0,
                'scanRequest',
                Zcl.Clusters.touchlink.ID,
                {transactionID: 1, zigbeeInformation: 4, touchlinkInformation: 18},
                {},
            );
            const sourcePanId: PanId = 0x1234;
            const sourceAddress: EUI64 = '0x1122334455aabbcc';
            const groupId: number = ZSpec.BroadcastAddress.SLEEPY;
            const lastHopLqi = 252;
            // Received Zigbee message from '0x', type 'readResponse', cluster 'genBasic', data '{"zclVersion":3}' from endpoint 1 with groupID 0
            const messageContents = Buffer.from('1800010000000100000000000000000088776655443322110154466341200', 'hex');

            mockEzspSendRawMessage.mockImplementationOnce(() => {
                setTimeout(async () => {
                    mockEzspEmitter.emit(EzspEvents.TOUCHLINK_MESSAGE, sourcePanId, sourceAddress, groupId, lastHopLqi, messageContents);
                    await flushPromises();
                }, 300);

                return SLStatus.OK;
            });

            const p = adapter.sendZclFrameInterPANBroadcast(zclFrame, 10000);

            await jest.advanceTimersByTimeAsync(5000);

            const payload: ZclPayload = {
                clusterID: Zcl.Clusters.touchlink.ID,
                header: Zcl.Header.fromBuffer(messageContents),
                address: sourceAddress,
                data: messageContents,
                endpoint: FIXED_ENDPOINTS[0].endpoint,
                linkquality: lastHopLqi,
                groupID: groupId,
                wasBroadcast: true,
                destinationEndpoint: FIXED_ENDPOINTS[0].endpoint,
            };

            await expect(p).resolves.toStrictEqual(payload);
            expect(mockEzspSendRawMessage).toHaveBeenCalledTimes(1);
            expect(mockEzspSendRawMessage).toHaveBeenCalledWith(expect.any(Buffer), 1, true);
        });

        it('Adapter impl: throws when sendZclFrameInterPANBroadcast command has no response', async () => {
            const commandName = 'readRsp';
            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                false,
                null,
                3,
                commandName,
                'genBasic',
                [{attrId: 0}],
                {},
            );

            await expect(adapter.sendZclFrameInterPANBroadcast(zclFrame, 10000)).rejects.toThrow(
                `Command '${commandName}' has no response, cannot wait for response.`,
            );
            expect(mockEzspSendRawMessage).toHaveBeenCalledTimes(0);
        });

        it('Adapter impl: throws when sendZclFrameInterPANBroadcast request fails', async () => {
            mockEzspSendRawMessage.mockResolvedValueOnce(SLStatus.BUSY);

            const zclFrame = Zcl.Frame.create(
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.CLIENT_TO_SERVER,
                false,
                null,
                3,
                'read',
                'genBasic',
                [{attrId: 0}],
                {},
            );

            await expect(adapter.sendZclFrameInterPANBroadcast(zclFrame, 10000)).rejects.toThrow(
                `~x~> [ZCL TOUCHLINK BROADCAST] Failed to send with status=${SLStatus[SLStatus.BUSY]}.`,
            );
            expect(mockEzspSendRawMessage).toHaveBeenCalledTimes(1);
            expect(mockEzspSendRawMessage).toHaveBeenCalledWith(expect.any(Buffer), 1, true);
        });

        it('Adapter impl: restoreChannelInterPAN', async () => {
            const p = adapter.restoreChannelInterPAN();

            await jest.advanceTimersByTimeAsync(10000);
            await expect(p).resolves.toStrictEqual(undefined);
            expect(mockEzspSetLogicalAndRadioChannel).toHaveBeenCalledWith(DEFAULT_NETWORK_OPTIONS.channelList[0]);
        });

        it('Adapter impl: throws when restoreChannelInterPAN fails request', async () => {
            mockEzspSetLogicalAndRadioChannel.mockResolvedValueOnce(SLStatus.FAIL);

            const p = defuseRejection(adapter.restoreChannelInterPAN());

            await jest.advanceTimersByTimeAsync(10000);
            await expect(p).rejects.toThrow(
                `Failed to restore InterPAN channel to '${DEFAULT_NETWORK_OPTIONS.channelList[0]}' with status=${SLStatus[SLStatus.FAIL]}.`,
            );
            expect(mockEzspSetLogicalAndRadioChannel).toHaveBeenCalledWith(DEFAULT_NETWORK_OPTIONS.channelList[0]);
        });
    });
});
