import Web3 from "web3";
import {
  Chain,
  CheckedContract,
  JsonInput,
  Match,
  Metadata,
  StringMap,
} from "@ethereum-sourcify/core";
import {
  decode as bytecodeDecode,
  splitAuxdata,
} from "@ethereum-sourcify/bytecode-utils";
import semverSatisfies from "semver/functions/satisfies";
import * as utils from "./utils";

export class SupportedChain {
  web3array: Web3[];
  rpc: string[];
  name: string;
  contractFetchAddress?: string;
  graphQLFetchAddress?: string;
  txRegex?: string;
  // archiveWeb3: Web3;

  constructor(chain: Chain) {
    this.web3array = [];
    this.rpc = chain.rpc;
    this.name = chain.name;
    this.contractFetchAddress = chain.contractFetchAddress;
    this.graphQLFetchAddress = chain.graphQLFetchAddress;
    this.txRegex = chain.txRegex;
    // this.archiveWeb3 = chain.archiveWeb3;
  }
}

export interface SupportedChainMap {
  [id: string]: SupportedChain;
}

export interface SupportedChainsConfig {
  web3timeout?: number;
}

export async function createSupportedChains(
  chainsData: Chain[],
  options: SupportedChainsConfig
): Promise<SupportedChainMap> {
  const supportedChains: SupportedChainMap = {};
  for (const chain of chainsData) {
    supportedChains[chain.chainId] = new SupportedChain(chain);

    supportedChains[chain.chainId].web3array = chain.rpc
      .filter((rpcURL: string) => !!rpcURL)
      .map((rpcURL: string) => {
        const opts = { timeout: options.web3timeout || 3000 };
        const web3 = rpcURL.startsWith("http")
          ? new Web3(new Web3.providers.HttpProvider(rpcURL, opts))
          : new Web3(new Web3.providers.WebsocketProvider(rpcURL, opts));
        return web3;
      });
  }
  return supportedChains;
}

export async function getBytecode(
  suppertedChains: SupportedChainMap,
  address: string,
  chainId: string
): Promise<any> {
  return await utils.getBytecode(suppertedChains[chainId].web3array, address);
}

/**
 * Recompiles a checked contract returning
 * @param  {CheckedContract} contract the checked contract to recompile
 * @return {Promise<object>} creationBytecode & deployedBytecode & metadata of successfully recompiled contract
 */
export async function recompile(contract: CheckedContract): Promise<any> {
  if (!CheckedContract.isValid(contract)) {
    await CheckedContract.fetchMissing(contract);
  }

  return await utils.recompile(contract.metadata, contract.solidity);
}

export function getMetadataPathFromCborEncoded(
  bytecode: string
): string | null {
  const cborData = bytecodeDecode(bytecode);

  if (cborData["bzzr0"]) {
    return `/swarm/bzzr0/${cborData["bzzr0"]}`;
  } else if (cborData["bzzr1"]) {
    return `/swarm/bzzr1/${cborData["bzzr1"]}`;
  } else if (cborData["ipfs"]) {
    return `/ipfs/${cborData["ipfs"]}`;
  }

  return null;
}

export function extractEncodedConstructorArgs(
  creationData: string,
  compiledCreationBytecode: string
) {
  const startIndex = creationData.indexOf(compiledCreationBytecode);
  return (
    "0x" + creationData.slice(startIndex + compiledCreationBytecode.length)
  );
}

/**
 * Returns the `creationData` from the transaction that created the contract at the provided chain and address.
 * @param chain
 * @param contractAddress
 * @returns `creationData` if found, `null` otherwise
 */
export async function getCreationData(
  suppertedChains: SupportedChainMap,
  chain: string,
  contractAddress: string
): Promise<string> {
  const loc = "[GET_CREATION_DATA]";
  const txFetchAddress = suppertedChains[chain]?.contractFetchAddress?.replace(
    "${ADDRESS}",
    contractAddress
  );
  const txRegex = suppertedChains[chain].txRegex;

  let creationData: false | string = false;
  if (txFetchAddress && txRegex) {
    // fetch from a block explorer and extract by regex
    for (const web3 of suppertedChains[chain].web3array) {
      try {
        creationData = await utils.getCreationDataByScraping(
          txFetchAddress,
          txRegex,
          web3
        );
        break;
      } catch (err: any) {
        // Error catched later
      }
    }
  }

  // Telos
  if (txFetchAddress && (chain == "40" || chain == "41")) {
    for (const web3 of suppertedChains[chain].web3array) {
      try {
        creationData = await utils.getCreationDataTelos(txFetchAddress, web3);
        break;
      } catch (err: any) {
        // Error catched later
      }
    }
  }
  if (txFetchAddress && (chain == "50" || chain == "51")) {
    for (const web3 of suppertedChains[chain].web3array) {
      try {
        creationData = await utils.getCreationDataXDC(txFetchAddress, web3);
        break;
      } catch (err: any) {
        // Error catched later
      }
    }
  }

  // Meter network
  if (txFetchAddress && (chain == "83" || chain == "82")) {
    for (const web3 of suppertedChains[chain].web3array) {
      try {
        creationData = await utils.getCreationDataMeter(txFetchAddress, web3);
        break;
      } catch (err: any) {
        // Error catched later
      }
    }
  }

  // Avalanche Subnets
  if (
    txFetchAddress &&
    ["11111", "335", "53935", "432201", "432204"].includes(chain)
  ) {
    for (const web3 of suppertedChains[chain].web3array) {
      try {
        creationData = await utils.getCreationDataAvalancheSubnet(
          txFetchAddress,
          web3
        );
        break;
      } catch (err: any) {
        // Error catched later
      }
    }
  }

  const graphQLFetchAddress = suppertedChains[chain].graphQLFetchAddress;
  if (graphQLFetchAddress) {
    // fetch from graphql node
    for (const web3 of suppertedChains[chain].web3array) {
      try {
        creationData = await utils.getCreationDataFromGraphQL(
          graphQLFetchAddress,
          contractAddress,
          web3
        );
        break;
      } catch (err: any) {
        // Error catched later
      }
    }
  }

  // Commented out for publishing chains in sourcify-chains at /chains endpoint. Also, since all chains with archiveWeb3 (Ethereum networks) already had txRegex and txFetchAddress, this block of code never executes.
  // const archiveWeb3 = suppertedChains[chain].archiveWeb3;
  // if (archiveWeb3) { // fetch by binary search on chain history
  //     try {
  //         return await getCreationDataFromArchive(contractAddress, archiveWeb3);
  //     } catch(err: any) {
  //     }
  // }

  if (creationData) {
    return creationData;
  } else {
    const error = new Error(
      `Cannot fetch creation data via ${txFetchAddress} on chainId ${chain} of contract ${contractAddress}`
    );
    throw error;
  }
}

/**
 * Searches a set of addresses for the one whose deployedBytecode
 * matches a given bytecode string
 * @param {String[]}          addresses
 * @param {string}      deployedBytecode
 */
export async function matchBytecodeToAddress(
  suppertedChains: SupportedChainMap,
  chain: string,
  addresses: string[] = [],
  recompiled: utils.RecompilationResult,
  metadata: Metadata
): Promise<Match> {
  let match: Match = { address: addresses[0], chainId: chain, status: null };
  const chainName = suppertedChains[chain].name || "The chain";

  for (let address of addresses) {
    address = Web3.utils.toChecksumAddress(address);

    let deployedBytecode: string | null = null;
    deployedBytecode = await getBytecode(suppertedChains, address, chain);

    try {
      match = await compareBytecodes(
        suppertedChains,
        deployedBytecode,
        recompiled,
        chain,
        address
      );
    } catch (err: any) {
      if (addresses.length === 1) {
        err?.message
          ? (match.message = err.message)
          : (match.message =
              "There were problems during contract verification. Please try again in a minute.");
      }
    }

    if (match.status) {
      break;
    } else if (addresses.length === 1 && !match.message) {
      if (!deployedBytecode) {
        match.message = `${chainName} is temporarily unavailable.`;
      } else if (deployedBytecode === "0x") {
        match.message = `${chainName} does not have a contract deployed at ${address}.`;
      }
      // Case when extra unused files in compiler input cause different bytecode (https://github.com/ethereum/sourcify/issues/618)
      else if (
        semverSatisfies(metadata.compiler.version, "=0.6.12 || =0.7.0") &&
        metadata.settings.optimizer?.enabled
      ) {
        const deployedMetadataHash =
          getMetadataPathFromCborEncoded(deployedBytecode);
        const recompiledMetadataHash = getMetadataPathFromCborEncoded(
          recompiled.deployedBytecode
        );
        // Metadata hashes match but bytecodes don't match.
        if (deployedMetadataHash === recompiledMetadataHash) {
          match.status = "extra-file-input-bug";
          match.message =
            "It seems your contract has either Solidity v0.6.12 or v0.7.0, and the metadata hashes match but not the bytecodes. You should add all the files input the compiler during compilation and remove all others. See the issue for more information: https://github.com/ethereum/sourcify/issues/618";
        } else {
          match.message = "The deployed and recompiled bytecode don't match.";
        }
      } else {
        match.message = "The deployed and recompiled bytecode don't match.";
      }
    }
  }

  return match;
}

export function addLibraryAddresses(
  template: string,
  real: string
): {
  replaced: string;
  libraryMap: StringMap;
} {
  const PLACEHOLDER_START = "__$";
  const PLACEHOLDER_LENGTH = 40;

  const libraryMap: StringMap = {};

  let index = template.indexOf(PLACEHOLDER_START);
  for (; index !== -1; index = template.indexOf(PLACEHOLDER_START)) {
    const placeholder = template.slice(index, index + PLACEHOLDER_LENGTH);
    const address = real.slice(index, index + PLACEHOLDER_LENGTH);
    libraryMap[placeholder] = address;
    const regexCompatiblePlaceholder = placeholder
      .replace("__$", "__\\$")
      .replace("$__", "\\$__");
    const regex = RegExp(regexCompatiblePlaceholder, "g");
    template = template.replace(regex, address);
  }

  return {
    replaced: template,
    libraryMap,
  };
}

/**
 * Returns a string description of how closely two bytecodes match. Bytecodes
 * that match in all respects apart from their metadata hashes are 'partial'.
 * Bytecodes that don't match are `null`.
 * @param  {string} deployedBytecode
 * @param  {string} creationData
 * @param  {string} compiledRuntimeBytecode
 * @param  {string} compiledCreationBytecode
 * @param  {string} chain chainId of the chain where contract is being checked
 * @param  {string} address contract address
 * @return {Match}  match description ('perfect'|'partial'|null) and possibly constructor args (ABI-encoded) and library links
 */
export async function compareBytecodes(
  suppertedChains: SupportedChainMap,
  deployedBytecode: string | null,
  recompiled: utils.RecompilationResult,
  chain: string,
  address: string,
  creationData?: string
): Promise<Match> {
  const match: Match = {
    address,
    chainId: chain,
    status: null,
    encodedConstructorArgs: undefined,
    libraryMap: undefined,
  };

  if (deployedBytecode && deployedBytecode.length > 2) {
    const { replaced, libraryMap } = addLibraryAddresses(
      recompiled.deployedBytecode,
      deployedBytecode
    );
    recompiled.deployedBytecode = replaced;
    match.libraryMap = libraryMap;

    if (deployedBytecode === recompiled.deployedBytecode) {
      // if the bytecode doesn't contain metadata then "partial" match
      if (getMetadataPathFromCborEncoded(deployedBytecode) === null) {
        match.status = "partial";
      } else {
        match.status = "perfect";
      }
    } else {
      const [trimmedDeployedBytecode] = splitAuxdata(deployedBytecode);
      const [trimmedCompiledRuntimeBytecode] = splitAuxdata(
        recompiled.deployedBytecode
      );
      if (trimmedDeployedBytecode === trimmedCompiledRuntimeBytecode) {
        match.status = "partial";
      } else if (
        trimmedDeployedBytecode.length === trimmedCompiledRuntimeBytecode.length
      ) {
        creationData =
          creationData ||
          (await getCreationData(suppertedChains, chain, address));

        const { replaced, libraryMap } = addLibraryAddresses(
          recompiled.creationBytecode,
          creationData
        );
        recompiled.creationBytecode = replaced;
        match.libraryMap = libraryMap;

        if (creationData) {
          if (creationData.startsWith(recompiled.creationBytecode)) {
            // The reason why this uses `startsWith` instead of `===` is that
            // creationData may contain constructor arguments at the end part.
            const encodedConstructorArgs = extractEncodedConstructorArgs(
              creationData,
              recompiled.creationBytecode
            );
            match.status = "perfect";
            match.encodedConstructorArgs = encodedConstructorArgs;
          } else {
            const [trimmedCompiledCreationBytecode] = splitAuxdata(
              recompiled.creationBytecode
            );

            if (creationData.startsWith(trimmedCompiledCreationBytecode)) {
              match.status = "partial";
            }
          }
        }
      }
    }
  }
  return match;
}

export async function getMetadataFromJsonInput(
  compilerVersion: string,
  contractName: string,
  compilerJson: JsonInput
): Promise<Metadata> {
  const output = await utils.useCompiler(compilerVersion, compilerJson);
  const contractPath = utils.findContractPathFromContractName(
    output.contracts,
    contractName
  );

  if (!contractPath)
    throw new Error(`Contract ${contractName} not found in compiler output`);

  if (
    !output.contracts ||
    !output.contracts[contractPath] ||
    !output.contracts[contractPath][contractName] ||
    !output.contracts[contractPath][contractName].metadata
  ) {
    const errorMessages = output.errors
      .filter((e: any) => e.severity === "error")
      .map((e: any) => e.formattedMessage)
      .join("\n");
    const error = new Error("Compiler error:\n " + errorMessages);
    throw error;
  }

  return JSON.parse(
    output.contracts[contractPath][contractName].metadata.trim()
  );
}

/**
 * Throws if addresses array contains a null value (express) or is length 0
 * @param {string[] = []} addresses param (submitted to injector)
 */
export function validateAddresses(addresses: string[] = []) {
  const err = new Error("Missing address for submitted sources/metadata");

  if (!addresses.length) {
    throw err;
  }

  for (const address of addresses) {
    if (address == null) throw err;
  }
}

/**
 * Throws if `chain` is falsy or wrong type
 * @param {string} chain param (submitted to injector)
 */
export function validateChain(chain: string) {
  if (!chain || typeof chain !== "string") {
    throw new Error("Missing chain for submitted sources/metadata");
  }
}

export function toChecksumAddress(address: string) {
  return Web3.utils.toChecksumAddress(address);
}
