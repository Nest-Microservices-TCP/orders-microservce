import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { PrismaClient } from '@prisma/client';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { ChangeOrderStatusDto, OrderPaginationDto, PaidOrderDto } from './dto';
import { NATS_SERVICE } from 'src/config/services';
import { catchError, firstValueFrom } from 'rxjs';
import { OrderWithProducts } from './interfaces/order-with-products.interface';

@Injectable()
export class OrdersService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger('OrdersService');

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');
  }

  constructor(
    @Inject(NATS_SERVICE)
    private readonly client: ClientProxy,
  ) {
    super();
  }

  async create(createOrderDto: CreateOrderDto) {
    const { items } = createOrderDto;

    const productsIds = Array.from(
      new Set(items.map((item) => item.productId)),
    );

    const products: any[] = await this.findProductsOrder(productsIds);

    const { totalAmount, totalItems } = createOrderDto.items.reduce(
      (acc, orderItem) => {
        const product = products.find(
          (product) => product.id === orderItem.productId,
        );
        const price = product ? product.price : 0;

        acc.totalAmount += price * orderItem.quantity;
        acc.totalItems += orderItem.quantity;

        return acc;
      },
      { totalAmount: 0, totalItems: 0 },
    );

    const order = await this.order.create({
      data: {
        totalAmount: totalAmount,
        totalItems: totalItems,
        OrderItem: {
          createMany: {
            data: createOrderDto.items.map((orderItem) => ({
              price: products.find(
                (product) => product.id === orderItem.productId,
              ).price,
              quantity: orderItem.quantity,
              productId: orderItem.productId,
            })),
          },
        },
      },
      include: {
        OrderItem: {
          select: {
            price: true,
            quantity: true,
            productId: true,
          },
        },
      },
    });

    return {
      ...order,
      OrderItem: order.OrderItem.map((orderItem) => ({
        ...orderItem,
        name: products.find((product) => product.id === orderItem.productId)
          .name,
      })),
    };
  }

  async findAll(orderPaginationDto: OrderPaginationDto) {
    const totalPages = await this.order.count({
      where: {
        status: orderPaginationDto.status,
      },
    });

    const currentPage = orderPaginationDto.page;
    const perPage = orderPaginationDto.limit;

    return {
      data: await this.order.findMany({
        skip: (currentPage - 1) * perPage,
        take: perPage,
        where: {
          status: orderPaginationDto.status,
        },
      }),
      meta: {
        total: totalPages,
        page: currentPage,
        lastPage: Math.ceil(totalPages / perPage),
      },
    };
  }

  async findOne(id: string) {
    const order = await this.order.findFirst({
      where: {
        id: id,
      },
      include: {
        OrderItem: {
          select: {
            productId: true,
            price: true,
            quantity: true,
          },
        },
      },
    });

    if (!order) {
      throw new RpcException({
        message: `Order with id=${id} not found`,
        status: HttpStatus.BAD_REQUEST,
      });
    }

    const productsIds = order.OrderItem.map((orderItem) => orderItem.productId);

    const products = await this.findProductsOrder(productsIds);

    return {
      ...order,
      OrderItem: order.OrderItem.map((orderItem) => ({
        ...orderItem,
        name: products.find((product) => product.id === orderItem.productId)
          .name,
      })),
    };
  }

  async changeStatus(changeOrderStatusDto: ChangeOrderStatusDto) {
    const { id, status } = changeOrderStatusDto;

    const order = await this.findOne(id);

    if (order.status === status) {
      return order;
    }

    return await this.order.update({
      where: {
        id: id,
      },
      data: {
        status: status,
      },
    });
  }

  async findProductsOrder(productsIds: number[]) {
    return await firstValueFrom(
      this.client.send({ cmd: 'validate_products' }, productsIds).pipe(
        catchError((err) => {
          throw new RpcException(err);
        }),
      ),
    );
  }

  async createPaymentSession(order: OrderWithProducts) {
    const paymentSession = await firstValueFrom(
      this.client
        .send('create.payment.session', {
          orderId: order.id,
          currency: 'usd',
          items: order.OrderItem.map((item) => ({
            name: item.name,
            price: item.price,
            quantity: item.quantity,
          })),
        })
        .pipe(
          catchError((error) => {
            throw new RpcException(error);
          }),
        ),
    );

    return paymentSession;
  }

  async paidOrder(paidOrderDto: PaidOrderDto) {
    this.logger.log('Paid Order');
    this.logger.log(paidOrderDto);

    const order = await this.order.update({
      where: { id: paidOrderDto.orderId },
      data: {
        status: 'PAID',
        paid: true,
        paidAt: new Date(),
        stripeChargeId: paidOrderDto.receiptUrl,

        // Relación con OrderReceipt
        OrderReceipt: {
          create: {
            receiptUrl: paidOrderDto.receiptUrl,
          },
        },
      },
    });

    return order;
  }
}
