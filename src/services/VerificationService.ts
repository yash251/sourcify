import {
  InjectorInput,
  Match,
  IFileService,
  Metadata,
  JsonInput,
  CheckedContract,
  SourcifyEventManager,
  getSupportedChains,
  MatchQuality,
  StringMap,
  Create2Args,
  Status,
  Create2ConstructorArgument,
} from "@ethereum-sourcify/core";
import {
  create as createIpfsClient,
  IPFSHTTPClient,
  globSource,
} from "ipfs-http-client";
import * as utils from "../utils";
import * as LibSourcify from "../LibSourcify";
import path from "path";

export interface IVerificationService {
  findByAddress(address: string, chain: string): Match[];
  findAllByAddress(address: string, chain: string): Match[];
  inject(injectorInput: InjectorInput): Promise<Match>;
  getMetadataFromJsonInput(
    compilerVersion: string,
    contractName: string,
    compilerJson: any
  ): Promise<Metadata>;
  verifyCreate2(
    contract: CheckedContract,
    deployerAddress: string,
    salt: string,
    constructorArgs: any,
    create2Address: string
  ): Promise<Match>;
  recompile(contract: CheckedContract): Promise<any>;
  getBytecode(address: string, chain: string): Promise<string>;
}

export default class VerificationService implements IVerificationService {
  fileService: IFileService;
  suppertedChains: LibSourcify.SupportedChainMap = {};

  private ipfsClient?: IPFSHTTPClient; // TODO: remove

  constructor(fileService: IFileService) {
    this.fileService = fileService;
    this.ipfsClient = createIpfsClient({ url: process.env.IPFS_API }); // TODO: remove
  }

  /**
   * Creates an instance of Injector. Waits for chains to initialize.
   * Await this method to work with an instance that has all chains initialized.
   * @param config
   */
  public static async createAsync(
    config: IFileService,
    initChainsOptions: LibSourcify.SupportedChainsConfig
  ): Promise<VerificationService> {
    const instance = new VerificationService(config);
    await instance.initChains(initChainsOptions);
    return instance;
  }

  /**
   * Instantiates a web3 provider for all supported Sourcify networks via their given RPCs.
   * If environment variable TESTING is set to true, localhost:8545 is also available.
   */
  private async initChains(options: LibSourcify.SupportedChainsConfig) {
    const chainsData = getSupportedChains();
    this.suppertedChains = await LibSourcify.createSupportedChains(
      chainsData,
      options
    );
  }

  getMetadataFromJsonInput = async (
    compilerVersion: string,
    contractName: string,
    compilerJson: JsonInput
  ): Promise<Metadata> => {
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
      SourcifyEventManager.trigger("Validation.Error", {
        message: error.message,
        stack: error.stack,
        details: {
          contractPath,
          contractName,
          compilerVersion,
          errorMessages,
        },
      });
      throw error;
    }

    return JSON.parse(
      output.contracts[contractPath][contractName].metadata.trim()
    );
  };

  findByAddress = (address: string, chain: string): Match[] => {
    // Try to find by address, return on success.
    let matches: Match[] = [];
    try {
      matches = this.fileService.findByAddress(address, chain);
    } catch (err) {
      // Error already logged inside `this.fileService.findByAddress`
    }
    return matches;
  };

  findAllByAddress = (address: string, chain: string): Match[] => {
    // Try to find by address, return on success.
    let matches: Match[] = [];
    try {
      matches = this.fileService.findAllByAddress(address, chain);
    } catch (err) {
      // Error already logged inside `this.fileService.findAllByAddress`
    }
    return matches;
  };

  /**
   * Used by the front-end. Accepts a set of source files and a metadata string,
   * recompiles / validates them and stores them in the repository by chain/address
   * and by swarm | ipfs hash.
   * @param  {string}            repository repository root (ex: 'repository')
   * @param  {string}            chain      chain name (ex: 'ropsten')
   * @param  {string}            address    contract address
   * @param  {string[]}          files
   * @return {Promise<object>}              address & status of successfully verified contract
   */
  inject = async (injectorInput: InjectorInput): Promise<Match> => {
    const { chain, addresses, contract } = injectorInput;
    LibSourcify.validateAddresses(addresses);
    LibSourcify.validateChain(chain);

    let match: Match;

    if (!CheckedContract.isValid(contract)) {
      await CheckedContract.fetchMissing(contract);
    }

    const compilationResult = await utils.recompile(
      contract.metadata,
      contract.solidity
    );

    // When injector is called by monitor, the bytecode has already been
    // obtained for address and we only need to compare w/ compilation result.
    if (injectorInput.bytecode) {
      if (addresses.length !== 1) {
        const err =
          "Injector cannot work with multiple addresses if bytecode is provided";
        const error = new Error(err);
        SourcifyEventManager.trigger("Verification.Error", {
          message: error.message,
          stack: error.stack,
          details: {
            addresses,
          },
        });
        throw error;
      }
      const address = LibSourcify.toChecksumAddress(addresses[0]);

      match = await LibSourcify.compareBytecodes(
        this.suppertedChains,
        injectorInput.bytecode,
        compilationResult,
        chain,
        address,
        injectorInput.creationData
      );

      // For other cases, we need to retrieve the code for specified address
      // from the chain.
    } else {
      match = await LibSourcify.matchBytecodeToAddress(
        this.suppertedChains,
        chain,
        addresses,
        compilationResult,
        contract.metadata
      );
    }

    await this.storeMatch(contract, compilationResult, match);

    return match;
  };

  verifyCreate2 = async (
    contract: CheckedContract,
    deployerAddress: string,
    salt: string,
    constructorArgs: any,
    create2Address: string
  ): Promise<Match> => {
    if (!CheckedContract.isValid(contract)) {
      await CheckedContract.fetchMissing(contract);
    }

    const constructorArgsTypes = constructorArgs.map(
      (arg: Create2ConstructorArgument) => arg.type
    );
    const constructorArgsValues = constructorArgs.map(
      (arg: Create2ConstructorArgument) => arg.value
    );

    const compilationResult = await utils.recompile(
      contract.metadata,
      contract.solidity
    );

    const computedAddr = utils.getCreate2Address({
      factoryAddress: deployerAddress,
      salt,
      contractBytecode: compilationResult.creationBytecode,
      constructorTypes: constructorArgsTypes,
      constructorArgs: constructorArgsValues,
    });

    if (create2Address !== computedAddr) {
      throw new Error(
        `The provided create2 address doesn't match server's generated one. Expected: ${computedAddr} ; Received: ${create2Address} ;`
      );
    }

    const encodedConstructorArgs = LibSourcify.extractEncodedConstructorArgs(
      compilationResult.creationBytecode,
      compilationResult.deployedBytecode
    );

    const { libraryMap } = LibSourcify.addLibraryAddresses(
      compilationResult.deployedBytecode,
      compilationResult.deployedBytecode
    );

    const create2Args: Create2Args = {
      deployerAddress,
      salt,
      constructorArgs,
    };

    const match: Match = {
      address: computedAddr,
      chainId: "0",
      status: "perfect",
      storageTimestamp: new Date(),
      encodedConstructorArgs: encodedConstructorArgs,
      create2Args,
      libraryMap: libraryMap,
    };

    await this.storeMatch(contract, compilationResult, match);

    return match;
  };

  recompile = async (contract: CheckedContract): Promise<any> => {
    return await LibSourcify.recompile(contract);
  };

  getBytecode = async (address: string, chainId: string): Promise<any> => {
    return await LibSourcify.getBytecode(
      this.suppertedChains,
      address,
      chainId
    );
  };

  // START:
  // THIS FUNCTIONS WILL BE MOVED IN ANOTHER SERVICE
  // THIS FUNCTIONS WILL BE MOVED IN ANOTHER SERVICE
  // THIS FUNCTIONS WILL BE MOVED IN ANOTHER SERVICE
  // THIS FUNCTIONS WILL BE MOVED IN ANOTHER SERVICE
  // THIS FUNCTIONS WILL BE MOVED IN ANOTHER SERVICE

  private sanitizePath(originalPath: string): string {
    return originalPath
      .replace(/[^a-z0-9_./-]/gim, "_")
      .replace(/(^|\/)[.]+($|\/)/, "_");
  }

  /**
   * This method exists because many different people have contributed to this code, which has led to the
   * lack of unanimous nomenclature
   * @param status
   * @returns {MatchQuality} matchQuality
   */
  private statusToMatchQuality(status: Status): MatchQuality {
    if (status === "perfect") return "full";
    if (status === "partial") return status;
    throw new Error(`Invalid match status: ${status}`);
  }

  /**
   * Stores the metadata from compilationResult to the swarm | ipfs subrepo. The exact storage path depends
   * on the swarm | ipfs address extracted from compilationResult.deployedByteode.
   *
   * @param chain used only for logging
   * @param address used only for loggin
   * @param compilationResult should contain deployedBytecode and metadata
   */
  private storeMetadata(
    matchQuality: MatchQuality,
    chain: string,
    address: string,
    compilationResult: utils.RecompilationResult
  ) {
    this.fileService.save(
      {
        matchQuality,
        chain,
        address,
        fileName: "metadata.json",
      },
      compilationResult.metadata
    );
  }

  /**
   * Writes the verified sources (.sol files) to the repository.
   * @param {string}              chain             chain name (ex: 'ropsten')
   * @param {string}              address           contract address
   * @param {StringMap}           sources           'rearranged' sources
   * @param {MatchQuality}        matchQuality
   */
  private storeSources(
    matchQuality: MatchQuality,
    chain: string,
    address: string,
    sources: StringMap
  ) {
    for (const sourcePath in sources) {
      this.fileService.save(
        {
          matchQuality,
          chain,
          address,
          source: true,
          fileName: this.sanitizePath(sourcePath),
        },
        sources[sourcePath]
      );
    }
  }

  /**
   * Writes the constructor arguments to the repository.
   * @param matchQuality
   * @param chain
   * @param address
   * @param encodedConstructorArgs
   */
  private storeConstructorArgs(
    matchQuality: MatchQuality,
    chain: string,
    address: string,
    encodedConstructorArgs: string
  ) {
    this.fileService.save(
      {
        matchQuality,
        chain,
        address,
        source: false,
        fileName: "constructor-args.txt",
      },
      encodedConstructorArgs
    );
  }

  /**
   * Writes the create2 arguments to the repository.
   * @param matchQuality
   * @param chain
   * @param address
   * @param create2Args
   */
  private storeCreate2Args(
    matchQuality: MatchQuality,
    chain: string,
    address: string,
    create2Args: Create2Args
  ) {
    this.fileService.save(
      {
        matchQuality,
        chain,
        address,
        source: false,
        fileName: "create2-args.json",
      },
      JSON.stringify(create2Args)
    );
  }

  /**
   * Writes the map of library links (pairs of the format <placeholder:address>) to the repository.
   * @param matchQuality
   * @param chain
   * @param address
   * @param libraryMap
   */
  private storeLibraryMap(
    matchQuality: MatchQuality,
    chain: string,
    address: string,
    libraryMap: StringMap
  ) {
    const indentationSpaces = 2;
    this.fileService.save(
      {
        matchQuality,
        chain,
        address,
        source: false,
        fileName: "library-map.json",
      },
      JSON.stringify(libraryMap, null, indentationSpaces)
    );
  }

  /**
   * Adds the verified contract's folder to IPFS via MFS
   *
   * @param matchQuality
   * @param chain
   * @param address
   */
  private async addToIpfsMfs(
    matchQuality: MatchQuality,
    chain: string,
    address: string
  ) {
    if (!this.ipfsClient) return;
    const contractFolderDir = this.fileService.generateAbsoluteFilePath({
      matchQuality,
      chain,
      address,
    });
    const ipfsMFSDir =
      "/" +
      this.fileService.generateRelativeContractDir({
        matchQuality,
        chain,
        address,
      });
    const filesAsyncIterable = globSource(contractFolderDir, "**/*");
    for await (const file of filesAsyncIterable) {
      if (!file.content) continue; // skip directories
      const mfsPath = path.join(ipfsMFSDir, file.path);
      await this.ipfsClient.files.mkdir(path.dirname(mfsPath), {
        parents: true,
      });
      // Readstream to Buffers
      const chunks: Uint8Array[] = [];
      for await (const chunk of file.content) {
        chunks.push(chunk);
      }
      const fileBuffer = Buffer.concat(chunks);
      const addResult = await this.ipfsClient.add(fileBuffer, {
        pin: false,
      });
      await this.ipfsClient.files.cp(addResult.cid, mfsPath, { parents: true });
    }
  }

  public async storeMatch(
    contract: CheckedContract,
    compilationResult: utils.RecompilationResult,
    match: Match
  ) {
    if (
      match.address &&
      (match.status === "perfect" || match.status === "partial")
    ) {
      // Delete the partial matches if we now have a perfect match instead.
      if (match.status === "perfect") {
        this.fileService.deletePartialIfExists(match.chainId, match.address);
      }
      const matchQuality = this.statusToMatchQuality(match.status);
      this.storeSources(
        matchQuality,
        match.chainId,
        match.address,
        contract.solidity
      );
      this.storeMetadata(
        matchQuality,
        match.chainId,
        match.address,
        compilationResult
      );

      if (match.encodedConstructorArgs && match.encodedConstructorArgs.length) {
        this.storeConstructorArgs(
          matchQuality,
          match.chainId,
          match.address,
          match.encodedConstructorArgs
        );
      }

      if (match.create2Args) {
        this.storeCreate2Args(
          matchQuality,
          match.chainId,
          match.address,
          match.create2Args
        );
      }

      if (match.libraryMap && Object.keys(match.libraryMap).length) {
        this.storeLibraryMap(
          matchQuality,
          match.chainId,
          match.address,
          match.libraryMap
        );
      }

      await this.addToIpfsMfs(matchQuality, match.chainId, match.address);
      SourcifyEventManager.trigger("Verification.MatchStored", match);
    } else if (match.status === "extra-file-input-bug") {
      return match;
    } else {
      const message =
        match.message ||
        "Could not match the deployed and recompiled bytecode.";
      const err = new Error(`Contract name: ${contract.name}. ${message}`);
      SourcifyEventManager.trigger("Verification.Error", {
        message: err.message,
        stack: err.stack,
        details: {
          chain: match.chainId,
          address: match.address,
        },
      });
      throw err;
    }
  }

  // END:
  // THIS FUNCTIONS WILL BE MOVED IN ANOTHER SERVICE
}
